import { Link, createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  getUser,
  getUserScoresBestWindow,
} from "../../lib/osu";
import {
  fetchLivePlayerCachedProfileSnapshot,
  fetchLivePlayerAboutDirect,
  fetchLivePlayerProfileSnapshot,
  fetchLivePlayerRecentScoresDirect,
  type LivePlayerProfileSnapshot,
} from "../../lib/live-backend";
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
import { DanBadge } from "../../components/ui/DanBadge";
import { ScoreRowSkeleton, Skeleton } from "../../components/ui/LoadingSkeleton";
import { UsernameText } from "../../components/ui/UsernameText";
import { ManiaCard3DPanel as ManiaCardPanel } from "../../components/player/maniacard3d/ManiaCard3DPanel";
import type { InsightScoreSnapshot, OsuManiaVariant, OsuScore, OsuUser, UserProfileInsights } from "../../lib/types";
import { calculateUserProfileInsights } from "../../lib/profile-insights";
import { pageSeo, playerOgImagePath } from "../../lib/seo";
import { getRankTierClass } from "../../lib/rankings";

const userRequestCache = new Map<string, Promise<OsuUser>>();
const userRecentRequestCache = new Map<number, Promise<OsuScore[]>>();
const userBestWindowRequestCache = new Map<number, Promise<OsuScore[]>>();
const userDataCache = new Map<string, { data: OsuUser; expiresAt: number }>();
const userRecentDataCache = new Map<number, { data: OsuScore[]; expiresAt: number }>();
const userBestWindowDataCache = new Map<number, { data: OsuScore[]; expiresAt: number }>();
const playerSnapshotDataCache = new Map<string, { data: { user: OsuUser; bestScores: OsuScore[] }; expiresAt: number }>();
const playerSnapshotRequestCache = new Map<string, Promise<{ user: OsuUser; bestScores: OsuScore[] } | null>>();
const playerAboutDataCache = new Map<number, { data: string | null; expiresAt: number }>();
const playerAboutRequestCache = new Map<string, Promise<string | null>>();
const USER_CLIENT_CACHE_TTL = 5 * 60 * 1000;
const USER_RECENT_CLIENT_CACHE_TTL = 2 * 60 * 1000;
const USER_BEST_WINDOW_CLIENT_CACHE_TTL = 5 * 60 * 1000;
const PLAYER_SNAPSHOT_CLIENT_CACHE_TTL = 5 * 60 * 1000;
const PLAYER_ABOUT_CLIENT_CACHE_TTL = 2 * 60 * 1000;
const PLAYER_ABOUT_LIVE_TIMEOUT_MS = 8_000;
const PLAYER_RECENT_LIVE_TIMEOUT_MS = 8_000;
const PROFILE_SNAPSHOT_BEST_GRACE_MS = 450;
const PROFILE_SNAPSHOT_REFRESH_DEFER_MS = 2500;
const PROFILE_CACHED_SNAPSHOT_LOADER_TIMEOUT_MS = 650;
const INITIAL_SCORE_BATCH_SIZE = 5;
const SHOW_MORE_BATCH_SIZE = 50;
const BEST_SCORES_WINDOW_SIZE = 200;
const RECENT_PRIORITY_DEFER_MS = 1200;
const TUNG_TUNG_SAHUR_AUDIO_SRC = "/audio/tung-tung-sahur-keycap.mp3";
const TUNG_TUNG_SAHUR_GLOW_COLORS = ["#38d9ff", "#ff3f57", "#8bff3f", "#b45cff", "#ffd53d", "#ff7a2f"];
const TUNG_TUNG_SAHUR_BASE_REST = { y: 0, scaleY: 1 };
const TUNG_TUNG_SAHUR_TOP_REST = { x: -3.25, y: 4, scaleY: 1, filter: "brightness(1)" };
const TUNG_TUNG_SAHUR_ACTUATION_MS = 49;
type PlayerTab = "best" | "recent" | "card" | "about";

type PlayerLoaderData = {
  cachedSnapshot: LivePlayerProfileSnapshot | null;
};

function withProfileLoaderBudget<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<null>((resolve) => {
    timeoutId = setTimeout(() => resolve(null), timeoutMs);
  });
  return Promise.race([
    promise.finally(() => {
      if (timeoutId) clearTimeout(timeoutId);
    }),
    timeoutPromise,
  ]);
}

export const Route = createFileRoute("/player/$username")({
  loader: async ({ params }): Promise<PlayerLoaderData> => {
    try {
      return {
        cachedSnapshot: await withProfileLoaderBudget(
          fetchLivePlayerCachedProfileSnapshot({ data: { key: params.username } }),
          PROFILE_CACHED_SNAPSHOT_LOADER_TIMEOUT_MS,
        ),
      };
    } catch {
      return { cachedSnapshot: null };
    }
  },
  head: ({ params, match }) =>
    pageSeo({
      title: `${params.username}`,
      description: `${params.username}'s osu!mania stats.`,
      path: `/player/${encodeURIComponent(params.username)}`,
      origin: match.context.origin,
      image: playerOgImagePath(params.username),
      type: "profile",
    }),
  component: PlayerPage,
});

type KeyFilter = "all" | string;
export type ModFilterMode = "include" | "exclude";
type ModFilterState = Record<string, ModFilterMode>;
type BestSort = "pp" | "newest" | "oldest";

// Synthetic chip used to filter for scores submitted without any mods.
const NO_MOD_KEY = "NM";

const MOD_USAGE_COLORS: Record<string, string> = {
  NM: "#4d8dff",
  NC: "#aa88ff",
  DT: "#ff6666",
  HR: "#ff6666",
  SD: "#ff6666",
  PF: "#ffcc22",
  AC: "#ff6666",
  BL: "#ff6666",
  ST: "#ff6666",
  MU: "#ff6666",
  EZ: "#b3d944",
  NF: "#b3d944",
  HT: "#b3d944",
  DC: "#b3d944",
  NR: "#b3d944",
  HD: "#ffcc22",
  FL: "#ffcc22",
  FI: "#ffcc22",
  AP: "#66ccff",
  RX: "#66ccff",
  SO: "#66ccff",
  RD: "#66ccff",
  AT: "#66ccff",
  CN: "#66ccff",
  MR: "#66ccff",
  AS: "#66ccff",
  CS: "#66ccff",
  TD: "#ff66aa",
  CL: "#aa88ff",
  CO: "#ffcc22",
  SV2: "#ffcc22",
};

function getModUsageColor(mod: string, fallbackIndex: number): string {
  const fallbackPalette = ["#ff66aa", "#ffcc22", "#34d399", "#fb923c", "#f472b6", "#22d3ee"];
  return MOD_USAGE_COLORS[mod] ?? fallbackPalette[fallbackIndex % fallbackPalette.length];
}

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

function hasProjectedOnlyProfileStats(user: OsuUser): boolean {
  const stats = user.statistics;
  const gradeCount =
    (stats.grade_counts?.ss ?? 0) +
    (stats.grade_counts?.ssh ?? 0) +
    (stats.grade_counts?.s ?? 0) +
    (stats.grade_counts?.sh ?? 0) +
    (stats.grade_counts?.a ?? 0);
  const hasRankingSignal =
    stats.pp > 0 ||
    stats.global_rank != null ||
    stats.country_rank != null;

  return hasRankingSignal &&
    stats.hit_accuracy === 0 &&
    stats.play_count === 0 &&
    (stats.play_time ?? 0) === 0 &&
    stats.total_hits === 0 &&
    gradeCount === 0;
}

function hasValidDate(value: string | null | undefined): value is string {
  if (!value) return false;
  return Number.isFinite(Date.parse(value));
}

export function cycleModFilterMode(current: ModFilterMode | undefined): ModFilterMode | undefined {
  if (current === undefined) return "include";
  if (current === "include") return "exclude";
  return undefined;
}

export function reverseCycleModFilterMode(current: ModFilterMode | undefined): ModFilterMode | undefined {
  if (current === undefined) return "exclude";
  if (current === "exclude") return "include";
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
  const cacheKey = username.trim().toLowerCase();
  const now = Date.now();
  const cachedData = userDataCache.get(cacheKey);
  if (cachedData && cachedData.expiresAt > now) {
    return Promise.resolve(cachedData.data);
  }
  if (cachedData) {
    userDataCache.delete(cacheKey);
  }

  const cached = userRequestCache.get(cacheKey);
  if (cached) return cached;

  const request = getUser({ data: { key: username } })
    .then((user) => {
      userDataCache.set(cacheKey, {
        data: user,
        expiresAt: Date.now() + USER_CLIENT_CACHE_TTL,
      });
      return user;
    })
    .finally(() => {
      userRequestCache.delete(cacheKey);
    });

  userRequestCache.set(cacheKey, request);
  return request;
}

function readCachedUser(username: string): OsuUser | undefined {
  const cacheKey = username.trim().toLowerCase();
  const cachedData = userDataCache.get(cacheKey);
  if (!cachedData) return undefined;
  if (cachedData.expiresAt <= Date.now()) {
    userDataCache.delete(cacheKey);
    return undefined;
  }
  return cachedData.data;
}

function loadPlayerSnapshotCached(username: string): Promise<{ user: OsuUser; bestScores: OsuScore[] } | null> {
  const cacheKey = username.trim().toLowerCase();
  const now = Date.now();
  const cachedData = playerSnapshotDataCache.get(cacheKey);
  if (cachedData && cachedData.expiresAt > now) {
    return Promise.resolve(cachedData.data);
  }
  if (cachedData) {
    playerSnapshotDataCache.delete(cacheKey);
  }

  const cached = playerSnapshotRequestCache.get(cacheKey);
  if (cached) return cached;

  const request = fetchLivePlayerProfileSnapshot({ data: { key: username } })
    .then((snapshot) => {
      if (!snapshot) return null;
      const data = {
        user: snapshot.user,
        bestScores: dedupeScores(snapshot.bestScores),
      };
      playerSnapshotDataCache.set(cacheKey, {
        data,
        expiresAt: Date.now() + PLAYER_SNAPSHOT_CLIENT_CACHE_TTL,
      });
      userDataCache.set(cacheKey, {
        data: data.user,
        expiresAt: Date.now() + USER_CLIENT_CACHE_TTL,
      });
      userBestWindowDataCache.set(data.user.id, {
        data: data.bestScores,
        expiresAt: Date.now() + USER_BEST_WINDOW_CLIENT_CACHE_TTL,
      });
      return data;
    })
    .catch(() => null)
    .finally(() => {
      playerSnapshotRequestCache.delete(cacheKey);
    });

  playerSnapshotRequestCache.set(cacheKey, request);
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

  const request = withTimeout(fetchLivePlayerRecentScoresDirect(userId), PLAYER_RECENT_LIVE_TIMEOUT_MS)
    .then((section) => section.payload)
    .then((scores) => {
      const dedupedScores = dedupeScores(scores);
      userRecentDataCache.set(userId, {
        data: dedupedScores,
        expiresAt: Date.now() + USER_RECENT_CLIENT_CACHE_TTL,
      });
      return dedupedScores;
    })
    .finally(() => {
      userRecentRequestCache.delete(userId);
    });

  userRecentRequestCache.set(userId, request);
  return request;
}

function readCachedUserRecent(userId: number): OsuScore[] | undefined {
  const cachedData = userRecentDataCache.get(userId);
  if (!cachedData) return undefined;
  if (cachedData.expiresAt <= Date.now()) {
    userRecentDataCache.delete(userId);
    return undefined;
  }
  return cachedData.data;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error("Request timed out.")), timeoutMs);
    promise
      .then(resolve, reject)
      .finally(() => window.clearTimeout(timeout));
  });
}

function loadPlayerAboutCached(userId: number, username: string): Promise<string | null> {
  const now = Date.now();
  const cachedData = playerAboutDataCache.get(userId);
  if (cachedData && cachedData.expiresAt > now) {
    return Promise.resolve(cachedData.data);
  }
  if (cachedData) {
    playerAboutDataCache.delete(userId);
  }

  const requestKey = `${userId}:${username.trim().toLowerCase()}`;
  const cached = playerAboutRequestCache.get(requestKey);
  if (cached) return cached;

  const request = withTimeout(fetchLivePlayerAboutDirect(userId), PLAYER_ABOUT_LIVE_TIMEOUT_MS)
    .then((section) => section?.payload.html ?? null)
    .finally(() => {
      playerAboutRequestCache.delete(requestKey);
    });

  playerAboutRequestCache.set(requestKey, request);
  return request.then((html) => {
    playerAboutDataCache.set(userId, {
      data: html,
      expiresAt: Date.now() + PLAYER_ABOUT_CLIENT_CACHE_TTL,
    });
    return html;
  });
}

function readCachedPlayerAbout(userId: number): string | null | undefined {
  const cachedData = playerAboutDataCache.get(userId);
  if (!cachedData) return undefined;
  if (cachedData.expiresAt <= Date.now()) {
    playerAboutDataCache.delete(userId);
    return undefined;
  }
  return cachedData.data;
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

  const request = getUserScoresBestWindow({ data: { userId, totalLimit: BEST_SCORES_WINDOW_SIZE, parallel: true } })
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

function PlayerPage() {
  const { username } = Route.useParams();
  const loaderData = Route.useLoaderData();
  const loaderSnapshot = loaderData?.cachedSnapshot ?? null;
  const loaderBestScores = useMemo(
    () => loaderSnapshot ? dedupeScores(loaderSnapshot.bestScores) : [],
    [loaderSnapshot],
  );
  const [user, setUser] = useState<OsuUser | null>(() => loaderSnapshot?.user ?? null);
  const [best, setBest] = useState<OsuScore[]>(() => loaderBestScores);
  const [recent, setRecent] = useState<OsuScore[]>([]);
  const [aboutHtml, setAboutHtml] = useState<string | null>(null);
  const [profileInsights, setProfileInsights] = useState<UserProfileInsights | null>(() =>
    loaderBestScores.length > 0 ? calculateUserProfileInsights(loaderBestScores) : null,
  );
  const [loadingUser, setLoadingUser] = useState(() => !loaderSnapshot?.user);
  const [loadingRecent, setLoadingRecent] = useState(true);
  const [loadingAbout, setLoadingAbout] = useState(false);
  const [loadingInsights, setLoadingInsights] = useState(() => loaderBestScores.length === 0);
  const [userError, setUserError] = useState<string | null>(null);
  const [bestError, setBestError] = useState<string | null>(null);
  const [recentError, setRecentError] = useState<string | null>(null);
  const [aboutError, setAboutError] = useState<string | null>(null);
  const [insightsError, setInsightsError] = useState<string | null>(null);
  const [tab, setTab] = useState<PlayerTab>("best");
  const [keyFilter, setKeyFilter] = useState<KeyFilter>("all");
  const [bestModFilter, setBestModFilter] = useState<ModFilterState>({});
  const [bestSort, setBestSort] = useState<BestSort>("pp");
  const [bestWindowLoaded, setBestWindowLoaded] = useState(() => loaderBestScores.length > 0);
  const [waitingForSnapshotBest, setWaitingForSnapshotBest] = useState(() => loaderBestScores.length === 0);
  const [avatarOpen, setAvatarOpen] = useState(false);
  const [modModalOpen, setModModalOpen] = useState(false);
  const [includeNoModUsage, setIncludeNoModUsage] = useState(true);
  const [hoveredMod, setHoveredMod] = useState<string | null>(null);
  const [bpmModalOpen, setBpmModalOpen] = useState(false);
  const [recentHasMore, setRecentHasMore] = useState(false);
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
    let snapshotTimer: number | null = null;
    const hasLoaderBestScores = loaderBestScores.length > 0;
    const seededUser = loaderSnapshot?.user ?? readCachedUser(username) ?? null;

    setUser(seededUser);
    setBest(loaderBestScores);
    setRecent([]);
    setAboutHtml(null);
    setProfileInsights(hasLoaderBestScores ? calculateUserProfileInsights(loaderBestScores) : null);
    setTab("best");
    setKeyFilter("all");
    setBestModFilter({});
    setBestSort("pp");
    setBestWindowLoaded(hasLoaderBestScores);
    setWaitingForSnapshotBest(!hasLoaderBestScores);
    setUserError(null);
    setBestError(null);
    setRecentError(null);
    setAboutError(null);
    setInsightsError(null);
    setLoadingUser(!seededUser);
    setLoadingRecent(false);
    setLoadingAbout(false);
    setLoadingInsights(!hasLoaderBestScores);
    setRecentHasMore(false);
    setBestVisibleCount(INITIAL_SCORE_BATCH_SIZE);
    setRecentVisibleCount(INITIAL_SCORE_BATCH_SIZE);

    let snapshotApplied = false;
    if (loaderSnapshot?.user) {
      const cacheKey = username.trim().toLowerCase();
      userDataCache.set(cacheKey, {
        data: loaderSnapshot.user,
        expiresAt: Date.now() + USER_CLIENT_CACHE_TTL,
      });
      if (hasLoaderBestScores) {
        userBestWindowDataCache.set(loaderSnapshot.user.id, {
          data: loaderBestScores,
          expiresAt: Date.now() + USER_BEST_WINDOW_CLIENT_CACHE_TTL,
        });
      }
    }

    const applySnapshot = (result: { user: OsuUser; bestScores: OsuScore[] } | null) => {
      if (cancelled || !result) return;
      snapshotApplied = true;
      setUser(result.user);
      setUserError(null);
      setLoadingUser(false);
      setWaitingForSnapshotBest(false);
      if (result.bestScores.length > 0) {
        const dedupedScores = dedupeScores(result.bestScores);
        setBest(dedupedScores);
        setBestWindowLoaded(true);
        setBestError(null);
        setProfileInsights(calculateUserProfileInsights(dedupedScores));
        setInsightsError(null);
        setLoadingInsights(false);
      }
    };

    const loadFallbackUser = () => loadUserCached(username)
      .then((result) => {
        if (cancelled) return;
        if (!snapshotApplied && !seededUser) setUser(result);
        setUserError(null);
      })
      .catch(() => {
        if (cancelled) return;
        if (!snapshotApplied && !seededUser) {
          setUserError("Couldn't load this player right now.");
          setLoadingInsights(false);
        }
      })
      .finally(() => {
        if (cancelled) return;
        if (!snapshotApplied && !seededUser) setLoadingUser(false);
      });

    const loadSnapshot = () => {
      loadPlayerSnapshotCached(username)
        .then((snapshot) => {
          if (cancelled) return;
          if (snapshot) {
            applySnapshot(snapshot);
            return;
          }
          setWaitingForSnapshotBest(false);
          if (!seededUser) void loadFallbackUser();
        })
        .catch(() => {
          if (cancelled) return;
          setWaitingForSnapshotBest(false);
          if (!seededUser) {
            void loadFallbackUser();
            return;
          }
          if (!snapshotApplied && !hasLoaderBestScores) setLoadingInsights(false);
        });
    };

    snapshotTimer = window.setTimeout(
      loadSnapshot,
      hasLoaderBestScores ? PROFILE_SNAPSHOT_REFRESH_DEFER_MS : 0,
    );

    return () => {
      cancelled = true;
      if (snapshotTimer) window.clearTimeout(snapshotTimer);
    };
  }, [loaderBestScores, loaderSnapshot, username]);

  useEffect(() => {
    if (!user || bestWindowLoaded || waitingForSnapshotBest) return;

    let cancelled = false;
    const timeout = window.setTimeout(
      loadBestWindow,
      tab === "recent" ? RECENT_PRIORITY_DEFER_MS : PROFILE_SNAPSHOT_BEST_GRACE_MS,
    );

    function loadBestWindow() {
      setLoadingInsights(true);
      // The 200-score window unlocks filters, show-more, and profile insights.
      loadUserBestWindowCached(user!.id)
        .then((windowScores) => {
          if (cancelled) return;
          const dedupedScores = dedupeScores(windowScores);
          setBest(dedupedScores);
          setBestWindowLoaded(true);
          setBestError(null);
          setProfileInsights(calculateUserProfileInsights(dedupedScores));
          setInsightsError(null);
        })
        .catch(() => {
          if (cancelled) return;
          setBestError("Couldn't load top plays right now.");
          setInsightsError("Couldn't load profile insights right now.");
        })
        .finally(() => {
          if (cancelled) return;
          setLoadingInsights(false);
        });
    }

    return () => {
      cancelled = true;
      if (timeout != null) window.clearTimeout(timeout);
    };
  }, [bestWindowLoaded, tab, user, waitingForSnapshotBest]);

  useEffect(() => {
    if (!user || tab !== "recent" || recent.length > 0) return;
    const cachedRecent = readCachedUserRecent(user.id);
    if (cachedRecent) {
      setRecent(cachedRecent);
      setRecentHasMore(false);
      setRecentError(null);
      setLoadingRecent(false);
      return;
    }

    let cancelled = false;
    setLoadingRecent(true);

    loadUserRecentCached(user.id)
      .then((recentScores) => {
        if (cancelled) return;
        setRecent(recentScores);
        setRecentHasMore(false);
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

    return () => {
      cancelled = true;
    };
  }, [recent.length, tab, user]);

  useEffect(() => {
    if (!user || tab !== "about" || aboutHtml != null) return;
    if (user.page?.html) {
      setAboutHtml(user.page.html);
      return;
    }
    const cachedAbout = readCachedPlayerAbout(user.id);
    if (cachedAbout !== undefined) {
      setAboutHtml(cachedAbout);
      return;
    }

    let cancelled = false;
    setLoadingAbout(true);
    setAboutError(null);

    loadPlayerAboutCached(user.id, user.username)
      .then((html) => {
        if (cancelled) return;
        setAboutHtml(html);
      })
      .catch(() => {
        if (cancelled) return;
        setAboutError("Couldn't load About right now.");
      })
      .finally(() => {
        if (cancelled) return;
        setLoadingAbout(false);
      });

    return () => {
      cancelled = true;
    };
  }, [aboutHtml, tab, user]);

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

  const relevantBestMods = useMemo(() => getRelevantMods(best), [best]);
  const bestPositionByIdentity = useMemo(() => {
    const positions = new Map<string, number>();
    best.forEach((score, index) => {
      positions.set(getScoreIdentity(score), index + 1);
    });
    return positions;
  }, [best]);

  const availableKeyModes = useMemo(
    () => getAvailableKeyModes([...best, ...recent]),
    [best, recent],
  );
  const displayedProfileInsights = profileInsights;
  const displayedAboutHtml = aboutHtml ?? (user ? readCachedPlayerAbout(user.id) : undefined);
  const profileStatsProjectedOnly = user ? hasProjectedOnlyProfileStats(user) : false;

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

  const reverseCycleBestMod = useCallback((mod: string) => {
    setBestModFilter((prev) => {
      const next = { ...prev };
      const cycled = reverseCycleModFilterMode(prev[mod]);
      if (cycled === undefined) {
        delete next[mod];
      } else {
        next[mod] = cycled;
      }
      return next;
    });
  }, []);

  if (loadingUser && !user) {
    return <PlayerPageSkeleton tab={tab} onTabChange={setTab} />;
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
  const loadingBest = best.length === 0 && !bestWindowLoaded && !bestError;
  const loadingScores = tab === "best" ? loadingBest : loadingRecent;
  const scoresError = tab === "best" ? bestError : recentError;
  const currentHasMore = tab === "best" ? !bestWindowLoaded : recentHasMore;
  const isLoadingMoreCurrentTab = false;
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
      : visibleScores.length > 0
        ? "loaded"
        : scoresError
          ? "error"
          : "empty";

  const avatarSrc = user.avatar_url;

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
              src={avatarSrc}
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
                const usageSampleSize = includeNoModUsage
                  ? profileInsights.sampleSize
                  : Math.max(profileInsights.sampleSize - noModCount, 0);
                const entries = [
                  ...profileInsights.modBreakdown,
                  ...(includeNoModUsage && noModCount > 0 ? [{ label: "NM", count: noModCount, total: profileInsights.sampleSize }] : []),
                ].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));

                const colored = entries.map((e, index) => ({
                  ...e,
                  color: getModUsageColor(e.label, index),
                  pct: usageSampleSize > 0 ? (e.count / usageSampleSize) * 100 : 0,
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
                const stacks = totalCount - usageSampleSize;

                return (
                  <>
                    <div className="pr-8 flex items-start justify-between gap-3">
                      <div>
                        <div className="text-[10px] uppercase tracking-wider text-osu-f1 font-semibold">Mod Usage</div>
                        <div className="mt-0.5 text-[11px] text-osu-f1/60 flex items-center gap-1.5 flex-wrap">
                          <span>across {usageSampleSize} {includeNoModUsage ? "top plays" : "modded top plays"}</span>
                          {stacks > 0 && (
                            <span
                              className="px-1.5 py-[1px] rounded bg-osu-b3/40 text-[9px] font-semibold uppercase tracking-wider text-osu-f1 cursor-help"
                              title={`${stacks} extra mod-use${stacks === 1 ? "" : "s"} from plays that stack mods (e.g. DT+MR). Slice sizes show share of mod-uses; percentages show share of plays.`}
                            >
                              +{stacks} stacked
                            </span>
                          )}
                        </div>
                      </div>
                      {noModCount > 0 && (
                        <button
                          type="button"
                          onClick={() => {
                            setIncludeNoModUsage((value) => !value);
                            setHoveredMod(null);
                          }}
                          aria-pressed={includeNoModUsage}
                          title={includeNoModUsage ? "NM is included in mod usage" : "NM is excluded from mod usage"}
                          className={`mt-0.5 flex h-6 flex-shrink-0 cursor-pointer items-center gap-1.5 rounded-full border px-1.5 text-[9px] font-semibold uppercase tracking-wider transition-colors hover:text-white ${includeNoModUsage
                              ? "border-osu-green-light/45 bg-osu-green-light/12 text-osu-green-light hover:border-osu-green-light/65 hover:bg-osu-green-light/18"
                              : "border-osu-b2/60 bg-osu-b3/30 text-osu-f1 hover:border-osu-b1/80 hover:bg-osu-b3/50"
                            }`}
                        >
                          <span>NM</span>
                          <span
                            className={`relative h-3.5 w-7 rounded-full transition-colors ${includeNoModUsage ? "bg-osu-green-light/80 shadow-[0_0_0_1px_rgba(179,217,68,0.28)]" : "bg-osu-b2"
                              }`}
                            aria-hidden="true"
                          >
                            <span
                              className="absolute left-0.5 top-0.5 h-2.5 w-2.5 rounded-full bg-white/95 transition-transform"
                              style={{ transform: includeNoModUsage ? "translateX(14px)" : "translateX(0)" }}
                            />
                          </span>
                        </button>
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
                              {focused.count} of {usageSampleSize}
                            </text>
                          </>
                        ) : (
                          <>
                            <text x={cx} y={cy + 2} textAnchor="middle" fill="#fff" style={{ fontSize: 28, fontWeight: 800 }}>
                              {usageSampleSize}
                            </text>
                            <text x={cx} y={cy + 20} textAnchor="middle" fill="var(--color-osu-f1)" style={{ fontSize: 9, letterSpacing: 1.5, textTransform: "uppercase" }}>
                              {includeNoModUsage ? "top plays" : "modded plays"}
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
                            <ModBadge mod={entry.label} size={0.85} color={entry.color} />
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
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 sm:backdrop-blur-sm cursor-pointer p-4"
            onClick={() => setBpmModalOpen(false)}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
          >
            <motion.div
              className="modal-card-mobile-safe relative isolate bg-osu-b4 border border-osu-b3/20 rounded-2xl w-[420px] max-w-full max-h-[85vh] overflow-hidden shadow-[0_12px_60px_rgba(0,0,0,0.7)] cursor-default"
              onClick={(e) => e.stopPropagation()}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 8 }}
              transition={{ duration: 0.16, ease: "easeOut" }}
            >
              <div className="pointer-events-none absolute inset-0 bg-osu-b4" aria-hidden="true" />
              <button
                type="button"
                onClick={() => setBpmModalOpen(false)}
                aria-label="Close"
                className="absolute top-3 right-3 z-20 w-7 h-7 flex items-center justify-center rounded-full text-osu-f1 hover:text-white hover:bg-osu-b3/50 transition-colors cursor-pointer"
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M1 1l12 12M13 1L1 13" />
                </svg>
              </button>
              <div className="relative z-10 max-h-[85vh] overflow-y-auto p-5 [scrollbar-gutter:stable]">
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
              </div>
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
                src={avatarSrc}
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
            showTungTungSahur={user.username.toLowerCase() === "sebasrj"}
          />

          {/* Secondary stats strip: compact inline row for the remaining mirror stats */}
          <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-3">
            <PpStat pp={stats.pp} variants={stats.variants} />
            <CompactStat label="Accuracy" value={profileStatsProjectedOnly ? "-" : formatAccuracy(stats.hit_accuracy / 100)} />
            <CompactStat label="Play Count" value={profileStatsProjectedOnly ? "-" : formatNumber(stats.play_count)} />
            <CompactStat label="Play Time" value={profileStatsProjectedOnly ? "-" : `${formatNumber(Math.floor((stats.play_time ?? 0) / 3600))}h`} />
          </div>

          {/* Profile insights */}
          <div className="mt-4">
            {loadingInsights ? (
              <InsightsSkeleton />
            ) : insightsError ? (
              <div className="rounded-xl border border-osu-b3/20 bg-osu-b4 px-4 py-3 text-sm text-osu-f1">
                {insightsError}
              </div>
            ) : displayedProfileInsights && displayedProfileInsights.sampleSize > 0 ? (() => {
              const profileInsights = displayedProfileInsights;
              return (
              <div className="space-y-3">
                {/* Row 1: Key Split + Most Used Mod + BPM + PP Range */}
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                  <KeySplitCard keySplit={profileInsights.keySplit} sampleSize={profileInsights.sampleSize} />
                  <div
                    className={`bg-osu-b4 rounded-xl p-3.5 border border-osu-b3/20 min-h-[90px] group ${profileInsights.mostUsedMod ? "cursor-pointer hover:border-osu-b3/50 transition-colors" : ""}`}
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
                    className={`bg-osu-b4 rounded-xl p-3.5 border border-osu-b3/20 min-h-[90px] group ${profileInsights.medianBpm != null ? "cursor-pointer hover:border-osu-b3/50 transition-colors" : ""}`}
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
                  <div className="bg-osu-b4 rounded-xl p-3.5 border border-osu-b3/20 min-h-[90px]">
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
                  <TopPlayCard label="Newest Top Play" snapshot={displayedProfileInsights.newestTopPlay} />
                  <TopPlayCard label="Oldest Top Play" snapshot={displayedProfileInsights.oldestTopPlay} />
                </div>
              </div>
              );
            })() : null}
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
                <span className="text-xs text-osu-f1 font-medium">{profileStatsProjectedOnly ? "-" : formatNumber(count)}</span>
              </div>
            ))}
            <div className="w-full sm:w-auto sm:ml-auto text-[11px] text-osu-f1 space-x-4">
              {!profileStatsProjectedOnly && hasValidDate(user.join_date) && (
                <span>
                  Joined <strong className="text-osu-l2">{formatDate(user.join_date)}</strong>
                </span>
              )}
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
              {((["best", "recent", "about", "card"]) as PlayerTab[]).map((t) => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className={`px-4 py-2.5 text-[12px] font-medium cursor-pointer transition-colors duration-[120ms] capitalize ${tab === t
                      ? "text-osu-c1 border-b-2 border-osu-h1"
                      : "text-osu-f1 hover:text-osu-l2"
                    }`}
                >
                  {t === "best" ? "Best Performance" : t === "recent" ? "Recent Plays" : t === "card" ? "Maniacard" : "About"}
                </button>
              ))}
            </div>
            {tab !== "about" && tab !== "card" && availableKeyModes.length > 1 && (
              <div className="flex items-center gap-1 rounded-lg bg-osu-b4/60 border border-osu-b3/20 p-1">
                {[["all", "All"] as const, ...availableKeyModes.map((k) => [k, k.toUpperCase()] as const)].map(([value, label]) => (
                  <button
                    key={value}
                    onClick={() => setKeyFilter(value)}
                    className={`px-3 py-1.5 rounded-md text-[11px] font-semibold transition-colors cursor-pointer ${keyFilter === value
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
              onReverseCycleMod={reverseCycleBestMod}
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
            {tab === "about" ? (
              <motion.div
                key="about"
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.14 }}
              >
                {loadingAbout ? (
                  <div className="space-y-2 rounded-xl bg-osu-b4 border border-osu-b3/20 p-5">
                    <Skeleton className="h-4 w-40" />
                    <Skeleton className="h-4 w-full" />
                    <Skeleton className="h-4 w-2/3" />
                  </div>
                ) : aboutError ? (
                  <div className="text-center py-8 text-osu-f1 text-sm">{aboutError}</div>
                ) : displayedAboutHtml ? (
                  <PlayerAboutCard html={displayedAboutHtml} />
                ) : (
                  <div className="text-center py-8 text-osu-f1 text-sm">No About content found.</div>
                )}
              </motion.div>
            ) : tab === "card" ? (
              <motion.div
                key="card"
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.14 }}
              >
                <ManiaCardPanel
                  user={user}
                  scores={best}
                  loading={!bestWindowLoaded}
                />
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
                  visibleScores.map((s: OsuScore, i: number) => {
                    const identity = getScoreIdentity(s);
                    const position = tab === "best" ? (bestPositionByIdentity.get(identity) ?? i + 1) : i + 1;
                    return <ScoreRow key={identity} score={s} position={position} />;
                  })
                ) : (
                  <div className="text-center py-8 text-osu-f1 text-sm">No scores found</div>
                )}
              </motion.div>
            )}
          </AnimatePresence>

          {tab !== "about" && tab !== "card" && !loadingScores && !scoresError && canShowMore && (
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

function TungTungSahurKeycap() {
  const [pressed, setPressed] = useState(false);
  const [actuated, setActuated] = useState(false);
  const [glowColor, setGlowColor] = useState(TUNG_TUNG_SAHUR_GLOW_COLORS[0]);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const actuationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearActuationTimer = useCallback(() => {
    if (!actuationTimerRef.current) return;
    clearTimeout(actuationTimerRef.current);
    actuationTimerRef.current = null;
  }, []);

  useEffect(() => {
    return () => {
      clearActuationTimer();
      const audio = audioRef.current;
      if (!audio) return;
      audio.pause();
      audio.currentTime = 0;
    };
  }, [clearActuationTimer]);

  const triggerActuation = useCallback(() => {
    actuationTimerRef.current = null;
    setActuated(true);
    setGlowColor((current) => {
      const choices = TUNG_TUNG_SAHUR_GLOW_COLORS.filter((color) => color !== current);
      return choices[Math.floor(Math.random() * choices.length)] ?? current;
    });

    const audio = audioRef.current ?? new Audio(TUNG_TUNG_SAHUR_AUDIO_SRC);
    audioRef.current = audio;
    audio.volume = 0.8;
    audio.currentTime = 0;
    void audio.play().catch(() => undefined);
  }, []);

  const release = useCallback(() => {
    clearActuationTimer();
    setPressed(false);
    setActuated(false);
  }, [clearActuationTimer]);

  const press = useCallback(() => {
    clearActuationTimer();
    setPressed(true);
    setActuated(false);
    actuationTimerRef.current = setTimeout(triggerActuation, TUNG_TUNG_SAHUR_ACTUATION_MS);
  }, [clearActuationTimer, triggerActuation]);

  return (
    <button
      type="button"
      aria-label="Tung tung sahur keycap"
      className="group absolute right-3 bottom-full z-20 h-28 w-16 translate-y-1 cursor-pointer touch-none select-none outline-none focus-visible:ring-2 focus-visible:ring-osu-pink/80 focus-visible:ring-offset-2 focus-visible:ring-offset-osu-b5 sm:right-5 sm:h-32 sm:w-[4.5rem]"
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        press();
      }}
      onPointerUp={release}
      onPointerCancel={release}
      onPointerLeave={release}
      onBlur={release}
      onKeyDown={(event) => {
        if ((event.key === " " || event.key === "Enter") && !event.repeat) press();
      }}
      onKeyUp={(event) => {
        if (event.key === " " || event.key === "Enter") release();
      }}
    >
      <span className="absolute inset-x-5 bottom-0 h-3 rounded-full bg-black/35 blur-md transition-opacity duration-200 group-hover:opacity-90" />
      <motion.img
        src="/images/easter-eggs/tung-tung-sahur-keycap-base.webp"
        alt=""
        draggable={false}
        className="absolute inset-x-0 bottom-0 z-10 mx-auto w-[61%] object-contain drop-shadow-[0_8px_16px_rgba(0,0,0,0.38)]"
        initial={TUNG_TUNG_SAHUR_BASE_REST}
        animate={{ y: pressed ? 1 : 0, scaleY: pressed ? 0.985 : 1 }}
        transition={{ type: "spring", stiffness: 520, damping: 34, mass: 0.65 }}
      />
      <motion.span
        className="absolute left-1/2 bottom-[37.5%] z-[18] h-3 w-8 -translate-x-1/2 rounded-full blur-sm"
        style={{
          background: `radial-gradient(ellipse, ${glowColor} 0%, ${glowColor}bb 38%, transparent 74%)`,
          boxShadow: `0 0 10px 3px ${glowColor}`,
        }}
        initial={{ opacity: 0, scale: 0.78 }}
        animate={{ opacity: actuated ? 1 : 0, scale: actuated ? 1.08 : 0.78 }}
        transition={{ duration: actuated ? 0.05 : 0.24, ease: "easeOut" }}
      />
      <motion.span
        className="absolute left-1/2 bottom-[38.6%] z-[19] h-1.5 w-6 -translate-x-1/2 rounded-full blur-[1px]"
        style={{
          background: `radial-gradient(ellipse, white 0%, ${glowColor} 45%, transparent 78%)`,
          boxShadow: `0 0 7px 2px ${glowColor}`,
        }}
        initial={{ opacity: 0, scaleX: 0.86 }}
        animate={{ opacity: actuated ? 1 : 0, scaleX: actuated ? 1.08 : 0.86 }}
        transition={{ duration: actuated ? 0.04 : 0.2, ease: "easeOut" }}
      />
      <motion.img
        src="/images/easter-eggs/tung-tung-sahur-keycap-top.webp"
        alt=""
        draggable={false}
        className="absolute inset-x-0 bottom-[35%] z-20 mx-auto w-[78%] object-contain drop-shadow-[0_8px_14px_rgba(0,0,0,0.42)]"
        initial={TUNG_TUNG_SAHUR_TOP_REST}
        animate={{
          x: -3.25,
          y: pressed ? 17 : 4,
          scaleY: pressed ? 0.972 : 1,
          filter: pressed ? "brightness(0.92)" : "brightness(1)",
        }}
        transition={{ type: "spring", stiffness: 640, damping: 31, mass: 0.55 }}
      />
      <motion.img
        src="/images/easter-eggs/tung-tung-sahur-keycap-base.webp"
        alt=""
        draggable={false}
        className="absolute inset-x-0 bottom-0 z-30 mx-auto w-[61%] object-contain"
        style={{ clipPath: "inset(12% 0 0 0)" }}
        initial={TUNG_TUNG_SAHUR_BASE_REST}
        animate={{ y: pressed ? 1 : 0, scaleY: pressed ? 0.985 : 1 }}
        transition={{ type: "spring", stiffness: 520, damping: 34, mass: 0.65 }}
      />
      <motion.img
        src="/images/easter-eggs/tung-tung-sahur-keycap-top.webp"
        alt=""
        draggable={false}
        className="absolute inset-x-0 bottom-[35%] z-40 mx-auto w-[78%] object-contain"
        style={{ clipPath: "inset(0 70% 0 0)" }}
        initial={TUNG_TUNG_SAHUR_TOP_REST}
        animate={{
          x: -3.25,
          y: pressed ? 17 : 4,
          scaleY: pressed ? 0.972 : 1,
          filter: pressed ? "brightness(0.92)" : "brightness(1)",
        }}
        transition={{ type: "spring", stiffness: 640, damping: 31, mass: 0.55 }}
      />
      <motion.img
        src="/images/easter-eggs/tung-tung-sahur-keycap-top.webp"
        alt=""
        draggable={false}
        className="absolute inset-x-0 bottom-[35%] z-40 mx-auto w-[78%] object-contain"
        style={{ clipPath: "inset(0 0 0 84%)" }}
        initial={TUNG_TUNG_SAHUR_TOP_REST}
        animate={{
          x: -3.25,
          y: pressed ? 17 : 4,
          scaleY: pressed ? 0.972 : 1,
          filter: pressed ? "brightness(0.92)" : "brightness(1)",
        }}
        transition={{ type: "spring", stiffness: 640, damping: 31, mass: 0.55 }}
      />
    </button>
  );
}

function PlayerPageSkeleton({
  tab,
  onTabChange,
}: {
  tab: PlayerTab;
  onTabChange: (tab: PlayerTab) => void;
}) {
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
            <div key={i} className="bg-osu-b4 rounded-xl px-4 py-2.5 border border-osu-b3/20 min-h-[46px] flex items-center justify-between gap-3">
              <Skeleton className="h-3 w-14" />
              <Skeleton className="h-4 w-16" />
            </div>
          ))}
        </div>

        <div className="space-y-3">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="bg-osu-b4 rounded-xl p-3.5 border border-osu-b3/20 min-h-[90px] space-y-2">
                <Skeleton className="h-3 w-20" />
                <Skeleton className="h-5 w-28" />
                <Skeleton className="h-3 w-20" />
              </div>
            ))}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {Array.from({ length: 2 }).map((_, i) => (
              <div key={i} className="bg-osu-b4 rounded-xl p-3.5 border border-osu-b3/20 h-[112px]">
                <Skeleton className="h-3 w-24" />
                <Skeleton className="h-4 w-40 mt-2" />
                <Skeleton className="h-3 w-32 mt-1" />
              </div>
            ))}
          </div>
        </div>

        <div className="mt-5 pt-1 border-t border-osu-b3/30">
          <div className="flex flex-wrap">
            {((["best", "recent", "card"]) as PlayerTab[]).map((t) => (
              <button
                key={t}
                onClick={() => onTabChange(t)}
                className={`px-4 py-2.5 text-[12px] font-medium cursor-pointer transition-colors duration-[120ms] capitalize ${tab === t
                    ? "text-osu-c1 border-b-2 border-osu-h1"
                    : "text-osu-f1 hover:text-osu-l2"
                  }`}
              >
                {t === "best" ? "Best Performance" : t === "recent" ? "Recent Plays" : "Maniacard"}
              </button>
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
  onReverseCycleMod,
  onClearMods,
  sort,
  onChangeSort,
}: {
  mods: string[];
  modFilter: ModFilterState;
  onCycleMod: (mod: string) => void;
  onReverseCycleMod: (mod: string) => void;
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
                  onContextMenu={() => onReverseCycleMod(mod)}
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
              className={`px-3 py-1.5 rounded-md text-[11px] font-semibold transition-colors cursor-pointer ${sort === value
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
  onContextMenu,
}: {
  mod: string;
  mode: ModFilterMode | undefined;
  onClick: () => void;
  onContextMenu: () => void;
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
      onContextMenu={(event) => {
        event.preventDefault();
        onContextMenu();
      }}
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
    <div className="bg-osu-b4 rounded-xl px-4 py-2.5 border border-osu-b3/20 min-h-[46px] flex items-center justify-between gap-3">
      <span className="text-[9px] uppercase tracking-wider text-osu-f1 font-semibold">{label}</span>
      <span className={`text-base font-bold tabular-nums ${accent ? "text-osu-yellow" : "text-white"}`}>{value}</span>
    </div>
  );
}

// PP stat: overall figure keeps the standard CompactStat shape on the left,
// with a tidy 4k/7k pp split anchored to the right edge. The split is only
// shown when both keymodes have pp — a single keymode carries no comparison,
// so single-keymode players keep the plain compact look. Each keymode row
// carries its global / country rank in a hover title.
function PpStat({ pp, variants }: { pp: number; variants?: OsuManiaVariant[] }) {
  const withPp = (variants ?? [])
    .filter((v) => v.mode === "mania" && v.pp > 0)
    .sort((a, b) => a.variant.localeCompare(b.variant));
  const keymodes = withPp.length >= 2 ? withPp : [];

  return (
    <div className="bg-osu-b4 rounded-xl px-4 py-2.5 border border-osu-b3/20 min-h-[46px] flex items-center justify-between gap-3">
      <div className="flex flex-col gap-0.5 min-w-0">
        <span className="text-[9px] uppercase tracking-wider text-osu-f1 font-semibold">PP</span>
        <span className="text-base font-bold tabular-nums text-osu-yellow leading-none">{formatNumber(Math.round(pp))}</span>
      </div>
      {keymodes.length > 0 && (
        <div className="flex flex-col gap-1 text-[10px] tabular-nums shrink-0">
          {keymodes.map((v) => (
            <div
              key={v.variant}
              className="flex items-center gap-1.5"
              title={[
                v.global_rank != null ? `#${formatNumber(v.global_rank)} global` : null,
                v.country_rank != null ? `#${formatNumber(v.country_rank)} country` : null,
              ].filter(Boolean).join("  •  ") || undefined}
            >
              <span className="font-bold uppercase text-osu-f1/70">{v.variant}</span>
              <span className="font-semibold text-white/85">{formatNumber(Math.round(v.pp))}</span>
            </div>
          ))}
        </div>
      )}
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
  showTungTungSahur = false,
}: {
  peakRank: number | null;
  peakRankDate: string | null;
  currentRank: number | null;
  countryRank: number | null;
  countryCode: string;
  rankHistory: number[] | null;
  showTungTungSahur?: boolean;
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
    <div className="relative">
      {showTungTungSahur && <TungTungSahurKeycap />}
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
    </div>
  );
}

function KeySplitCard({ keySplit, sampleSize }: { keySplit: UserProfileInsights["keySplit"]; sampleSize: number }) {
  const colors: Record<number, string> = { 4: "bg-osu-blue", 7: "bg-osu-pink", 6: "bg-osu-purple", 9: "bg-osu-orange" };
  const textColors: Record<number, string> = { 4: "text-osu-blue", 7: "text-osu-pink-light", 6: "text-osu-purple-light", 9: "text-osu-orange" };

  return (
    <div className="bg-osu-b4 rounded-xl p-3.5 border border-osu-b3/20 min-h-[90px]">
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
  const backgroundImage = snapshot.coverUrl
    ? `linear-gradient(90deg, rgba(0,0,0,0.85) 0%, rgba(0,0,0,0.60) 50%, rgba(0,0,0,0.80) 100%), url(${JSON.stringify(snapshot.coverUrl)})`
    : "linear-gradient(90deg, rgba(0,0,0,0.85) 0%, rgba(0,0,0,0.60) 50%, rgba(0,0,0,0.80) 100%)";

  return (
    <a
      href={snapshot.beatmapUrl}
      target="_blank"
      rel="noreferrer"
      className="block relative rounded-lg overflow-hidden border border-osu-b3/20 hover:border-osu-pink/30 transition-colors"
      style={{ backgroundImage, backgroundSize: "cover", backgroundPosition: "center" }}
    >
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
      <div className="bg-osu-b4 rounded-xl p-3.5 border border-osu-b3/20 h-[112px]">
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
      className="block relative rounded-xl overflow-hidden border border-osu-b3/20 bg-osu-b4 h-[112px] hover:border-osu-pink/30 transition-colors group/topplay"
    >
      {snapshot.coverUrl && (
        <img
          src={snapshot.coverUrl}
          alt=""
          className="absolute -inset-px h-[calc(100%+2px)] w-[calc(100%+2px)] max-w-none object-cover brightness-[0.42]"
        />
      )}
      <div className="absolute -inset-px bg-gradient-to-r from-black/45 via-black/10 to-black/35" />
      <div className="relative h-full p-3.5 flex items-center gap-3">
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
          <div key={i} className="bg-osu-b4 rounded-xl p-3.5 border border-osu-b3/20 min-h-[90px] space-y-2">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-5 w-28" />
            <Skeleton className="h-3 w-20" />
          </div>
        ))}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {Array.from({ length: 2 }).map((_, i) => (
          <div key={i} className="bg-osu-b4 rounded-xl p-3.5 border border-osu-b3/20 h-[112px]">
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
          <span className="hidden sm:inline flex-shrink-0"><DanBadge score={score} /></span>
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
          <DanBadge score={score} />
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
    <div className="player-score-row relative flex items-center gap-2 sm:gap-3 py-2.5 px-3 rounded-lg bg-osu-b4/50 hover:bg-osu-b4 transition-colors duration-[120ms]">
      {/* Mobile inline position number */}
      <span className="sm:hidden text-xs text-osu-f1 font-bold flex-shrink-0">{position}.</span>
      {/* Desktop hover position number */}
      <div
        className="score-position-indicator pointer-events-none absolute -left-14 top-1/2 -translate-y-1/2 w-10 text-right text-white/90 opacity-0 translate-x-2 transition-all duration-150 ease-out hidden sm:block"
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
