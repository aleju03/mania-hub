import { Link, createFileRoute, useLocation, useNavigate } from "@tanstack/react-router";
import { Suspense, lazy, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Pencil, X } from "lucide-react";
import {
  getUser,
  getUserScoresBestWindow,
} from "../../lib/osu";
import {
  fetchLivePlayerCachedProfileSnapshot,
  fetchLivePlayerActivityDirect,
  fetchLivePlayerActivityDayDirect,
  fetchLivePlayerAboutDirect,
  fetchLivePlayerProfileSnapshotDirect,
  fetchLivePlayerRecentScoresDirect,
  isLiveBackendConfigured,
  type LivePlayerActivityPatterns,
  type LivePlayerActivityPrimarySkill,
  type LivePlayerActivitySnapshot,
  type LivePlayerActivitySkillReadout,
  type LivePlayerActivitySkillVector,
  type LivePlayerActivityTimelineSegment,
  type LivePlayerProfileSnapshot,
} from "../../lib/live-backend";
import {
  formatNumber,
  formatAccuracy,
  formatTimeAgo,
  formatDetailedTimeAgo,
  formatDate,
  formatPP,
} from "../../lib/format";
import {
  getBeatmapUrl,
  getBeatmapKeyCount,
  getBeatmapKeymodeLabel,
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
import type { InsightScoreSnapshot, OsuCovers, OsuManiaVariant, OsuScore, OsuUser, UserProfileInsights } from "../../lib/types";
import { calculateUserProfileInsights } from "../../lib/profile-insights";
import { readPlayerShell } from "../../lib/player-shell-cache";
import { pageSeo, playerOgImagePath } from "../../lib/seo";
import { getRankTierClass } from "../../lib/rankings";

// The BBCode editor (toolbar + parser + preview) only loads when someone
// actually opens it; the about tab itself stays light.
const BBCodeEditorLazy = lazy(() => import("../../components/player/bbcode/BBCodeEditor"));

const userRequestCache = new Map<string, Promise<OsuUser>>();
const userRecentRequestCache = new Map<number, Promise<OsuScore[]>>();
const userBestWindowRequestCache = new Map<number, Promise<OsuScore[]>>();
const userDataCache = new Map<string, { data: OsuUser; expiresAt: number }>();
const userRecentDataCache = new Map<number, { data: OsuScore[]; expiresAt: number }>();
const userBestWindowDataCache = new Map<number, { data: OsuScore[]; expiresAt: number }>();
const playerSnapshotDataCache = new Map<string, { data: { user: OsuUser; bestScores: OsuScore[] }; expiresAt: number }>();
const playerSnapshotRequestCache = new Map<string, Promise<{ user: OsuUser; bestScores: OsuScore[] } | null>>();
interface PlayerAboutData {
  html: string | null;
  raw: string | null;
}
const playerAboutDataCache = new Map<number, { data: PlayerAboutData; expiresAt: number }>();
const playerAboutRequestCache = new Map<string, Promise<PlayerAboutData>>();
const USER_CLIENT_CACHE_TTL = 5 * 60 * 1000;
const USER_RECENT_CLIENT_CACHE_TTL = 2 * 60 * 1000;
const USER_BEST_WINDOW_CLIENT_CACHE_TTL = 5 * 60 * 1000;
const PLAYER_SNAPSHOT_CLIENT_CACHE_TTL = 5 * 60 * 1000;
const PLAYER_ABOUT_CLIENT_CACHE_TTL = 2 * 60 * 1000;
const PLAYER_ABOUT_LIVE_TIMEOUT_MS = 8_000;
const PLAYER_RECENT_LIVE_TIMEOUT_MS = 8_000;
const PROFILE_SNAPSHOT_BEST_GRACE_MS = 450;
const PROFILE_SNAPSHOT_REFRESH_DEFER_MS = 2500;
// With SSR pinned next to the backend (fra1 <-> Nuremberg, ~5ms RTT) the happy
// path is ~50ms; this budget exists to absorb backend event-loop stalls, which
// run ~0.5-1.5s. Waiting one out beats serving a skeleton: a miss costs the
// visitor a multi-second client-side refetch instead.
const PROFILE_CACHED_SNAPSHOT_LOADER_TIMEOUT_MS = 1_200;
const INITIAL_SCORE_BATCH_SIZE = 5;
const SHOW_MORE_BATCH_SIZE = 50;
const BEST_SCORES_WINDOW_SIZE = 200;
const RECENT_PRIORITY_DEFER_MS = 1200;
const TUNG_TUNG_SAHUR_AUDIO_SRC = "/audio/tung-tung-sahur-keycap.mp3";
const TUNG_TUNG_SAHUR_GLOW_COLORS = ["#38d9ff", "#ff3f57", "#8bff3f", "#b45cff", "#ffd53d", "#ff7a2f"];
const TUNG_TUNG_SAHUR_BASE_REST = { y: 0, scaleY: 1 };
const TUNG_TUNG_SAHUR_TOP_REST = { x: -3.25, y: 4, scaleY: 1, filter: "brightness(1)" };
const TUNG_TUNG_SAHUR_ACTUATION_MS = 49;
export type PlayerTab = "best" | "recent" | "card" | "about" | "activity";
type ActivityDay = {
  date: string;
  scoreCount: number;
  passedCount: number;
  sessionCount: number;
  mapCount: number;
  level: 0 | 1 | 2 | 3 | 4;
  maps: ActivityPlayedMap[];
  skills: ActivitySkillReadout | null;
  timeline: ActivityTimelineSegment[];
};

type ActivityPlayedMap = {
  key: string;
  beatmapId: number;
  beatmapsetId: number | null;
  title: string;
  artist: string;
  version: string;
  coverUrl: string | null;
  plays: number;
  accuracy: number | null;
  pp: number | null;
  rank: string | null;
  keyCount: number | null;
  skills: LivePlayerActivitySkillVector | null;
};

type ActivitySkillReadout = LivePlayerActivitySkillReadout;

type ActivityTimelineSegment = LivePlayerActivityTimelineSegment;

type ActivityWeek = {
  key: string;
  days: (ActivityDay | null)[];
};

type ActivitySummary = {
  days: ActivityDay[];
  weeks: ActivityWeek[];
  totalScores: number;
  activeDays: number;
  totalSessions: number;
  currentStreak: number;
  typicalSession: number;
  availableYears: number[];
  timezone: string;
};

const PLAYER_TABS: PlayerTab[] = ["best", "recent", "about", "card", "activity"];
const ACTIVITY_EMPTY_CELL_CLASS = "bg-osu-b4/45 border-osu-b3/25";
const PLAYER_ACTIVITY_COUNTRY_SCOPE = "GLOBAL";

function normalizePlayerTab(tab: PlayerTab): PlayerTab {
  return tab;
}

function getPlayerTabLabel(tab: PlayerTab): string {
  if (tab === "best") return "Best Performance";
  if (tab === "recent") return "Recent Plays";
  if (tab === "card") return "Maniacard";
  if (tab === "activity") return "Activity";
  return "About";
}

function getPlayerTabSlug(tab: PlayerTab): string | null {
  if (tab === "best") return null;
  if (tab === "card") return "maniacard";
  return tab;
}

function getPlayerTabPath(username: string, tab: PlayerTab): string {
  const encodedUsername = encodeURIComponent(username);
  const slug = getPlayerTabSlug(normalizePlayerTab(tab));
  return slug ? `/player/${encodedUsername}/${slug}` : `/player/${encodedUsername}`;
}

function getPlayerTabFromPathname(pathname: string): PlayerTab {
  const tabSlug = pathname.split("/").filter(Boolean)[2];
  if (tabSlug === "recent") return "recent";
  if (tabSlug === "about") return "about";
  if (tabSlug === "maniacard") return "card";
  if (tabSlug === "activity") return normalizePlayerTab("activity");
  return "best";
}

export type PlayerLoaderData = {
  cachedSnapshot: LivePlayerProfileSnapshot | null;
};

// The cached snapshot is dehydrated into the SSR HTML, so every byte here is
// document weight and hydration work (~580KB raw for a 200-score snapshot,
// dominated by fields nothing on this page reads). Rebuild user/scores from
// the typed fields only; the deferred post-mount refresh fetches the full
// payload straight from the server, and the about tab fetches page
// HTML on demand.
function slimLoaderScore(score: OsuScore): OsuScore {
  const { weight: _weight, ...rest } = score;
  return {
    ...rest,
    beatmap: score.beatmap ? {
      id: score.beatmap.id,
      beatmapset_id: score.beatmap.beatmapset_id,
      difficulty_rating: score.beatmap.difficulty_rating,
      mode: score.beatmap.mode,
      status: score.beatmap.status,
      total_length: score.beatmap.total_length,
      cs: score.beatmap.cs,
      drain: score.beatmap.drain,
      accuracy: score.beatmap.accuracy,
      ar: score.beatmap.ar,
      bpm: score.beatmap.bpm,
      convert: score.beatmap.convert,
      count_circles: score.beatmap.count_circles,
      count_sliders: score.beatmap.count_sliders,
      count_spinners: score.beatmap.count_spinners,
      max_combo: score.beatmap.max_combo,
      version: score.beatmap.version,
      url: score.beatmap.url,
    } : score.beatmap,
    beatmapset: score.beatmapset ? {
      id: score.beatmapset.id,
      title: score.beatmapset.title,
      artist: score.beatmapset.artist,
      creator: score.beatmapset.creator,
      user_id: score.beatmapset.user_id,
      status: score.beatmapset.status,
      play_count: score.beatmapset.play_count,
      favourite_count: score.beatmapset.favourite_count,
      submitted_date: score.beatmapset.submitted_date,
      ranked_date: score.beatmapset.ranked_date,
      last_updated: score.beatmapset.last_updated,
      bpm: score.beatmapset.bpm,
      preview_url: score.beatmapset.preview_url,
      covers: {
        list: score.beatmapset.covers?.list,
        cover: score.beatmapset.covers?.cover,
        "cover@2x": score.beatmapset.covers?.["cover@2x"],
      } as OsuCovers,
    } : score.beatmapset,
    user: score.user ? {
      id: score.user.id,
      username: score.user.username,
      avatar_url: score.user.avatar_url,
      country_code: score.user.country_code,
    } : score.user,
  };
}

function slimLoaderUser(user: OsuUser): OsuUser {
  return {
    id: user.id,
    username: user.username,
    avatar_url: user.avatar_url,
    cover_url: user.cover_url,
    cover: user.cover,
    country_code: user.country_code,
    country: user.country,
    join_date: user.join_date,
    last_visit: user.last_visit,
    is_active: user.is_active,
    is_online: user.is_online,
    is_supporter: user.is_supporter,
    statistics: user.statistics,
    rank_history: user.rank_history,
    rank_highest: user.rank_highest,
    page: null,
    badges: user.badges ?? [],
    user_achievements: [],
    follower_count: user.follower_count,
    mapping_follower_count: user.mapping_follower_count,
    previous_usernames: user.previous_usernames,
    playmode: user.playmode,
    playstyle: user.playstyle,
    post_count: user.post_count,
    comments_count: user.comments_count,
  };
}

function slimLoaderSnapshot(snapshot: LivePlayerProfileSnapshot): LivePlayerProfileSnapshot {
  return {
    ...snapshot,
    user: slimLoaderUser(snapshot.user),
    bestScores: snapshot.bestScores.map(slimLoaderScore),
  };
}

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

// SSR fetches to the server occasionally fail instantly when a kept-alive
// socket was closed by the proxy between requests; a fresh connection almost
// always succeeds, so one immediate retry turns those misses into hits.
async function fetchCachedSnapshotWithRetry(username: string): Promise<LivePlayerProfileSnapshot | null> {
  try {
    return await fetchLivePlayerCachedProfileSnapshot({ data: { key: username } });
  } catch {
    return fetchLivePlayerCachedProfileSnapshot({ data: { key: username } });
  }
}

export async function loadPlayerRouteData(username: string): Promise<PlayerLoaderData> {
  let cachedSnapshot: LivePlayerProfileSnapshot | null = null;
  try {
    cachedSnapshot = await withProfileLoaderBudget(
      fetchCachedSnapshotWithRetry(username),
      PROFILE_CACHED_SNAPSHOT_LOADER_TIMEOUT_MS,
    );
  } catch {
    cachedSnapshot = null;
  }

  return { cachedSnapshot: cachedSnapshot ? slimLoaderSnapshot(cachedSnapshot) : null };
}

export function buildPlayerRouteHead({
  username,
  origin,
  tab,
}: {
  username: string;
  origin: string;
  tab?: PlayerTab;
}) {
  const normalizedTab = normalizePlayerTab(tab ?? "best");
  const suffix = normalizedTab !== "best" ? ` ${getPlayerTabLabel(normalizedTab)}` : "";
  const path = getPlayerTabPath(username, normalizedTab);
  return pageSeo({
    title: `${username}${suffix}`,
    description: `${username}'s osu!mania stats.`,
    path,
    origin,
    image: playerOgImagePath(username),
    type: "profile",
  });
}

export const Route = createFileRoute("/player/$username")({
  loader: async ({ params }) => loadPlayerRouteData(params.username),
  head: ({ params, match }) =>
    buildPlayerRouteHead({ username: params.username, origin: match.context.origin }),
  component: PlayerDefaultRoute,
});

type KeyFilter = "all" | string;
export type ModFilterMode = "include" | "exclude";
type ModFilterState = Record<string, ModFilterMode>;
type BestSort = "pp" | "newest" | "oldest";
type BestAgeSort = Exclude<BestSort, "pp">;
type PpDistributionMode = "bands" | "cumulative";
type PpCumulativeDistributionRow = {
  threshold: number;
  count: number;
  total: number;
};

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
  return getBeatmapKeyCount(score.beatmap) === Number(keyFilter.replace("k", ""));
}

function getAvailableKeyModes(scores: OsuScore[]): string[] {
  const keys = new Set<number>();
  for (const score of scores) {
    const keyCount = getBeatmapKeyCount(score.beatmap);
    if (keyCount != null) keys.add(keyCount);
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

function getScoreListSignature(scores: OsuScore[]): string {
  return scores
    .map((score) => [
      getScoreIdentity(score),
      score.pp ?? "",
      score.accuracy ?? "",
      getScoreTimeMs(score),
    ].join(":"))
    .join("|");
}

function scoreListsAreEquivalent(a: OsuScore[], b: OsuScore[]): boolean {
  return a.length === b.length && getScoreListSignature(a) === getScoreListSignature(b);
}

function getPpCumulativeDistributionStep(top: number): number {
  return top < 250 ? 50 : 100;
}

function buildPpCumulativeDistribution(scores: OsuScore[]): PpCumulativeDistributionRow[] {
  const ppValues = scores
    .map((score) => score.pp)
    .filter((pp): pp is number => typeof pp === "number" && Number.isFinite(pp))
    .sort((a, b) => b - a);

  if (!ppValues.length) return [];

  const top = ppValues[0];
  const bottom = ppValues[ppValues.length - 1];
  const step = getPpCumulativeDistributionStep(top);
  const maxThreshold = Math.max(0, Math.floor(top / step) * step);
  const minThreshold = Math.max(0, Math.floor(bottom / step) * step);
  const rows: PpCumulativeDistributionRow[] = [];
  let count = 0;

  for (let threshold = maxThreshold; threshold >= minThreshold; threshold -= step) {
    while (count < ppValues.length && ppValues[count] >= threshold) {
      count += 1;
    }
    rows.push({ threshold, count, total: ppValues.length });
  }

  return rows;
}

function profileUsersAreEquivalent(a: OsuUser | null, b: OsuUser): boolean {
  if (!a) return false;
  return (
    a.id === b.id &&
    a.username === b.username &&
    a.avatar_url === b.avatar_url &&
    a.country_code === b.country_code &&
    a.is_online === b.is_online &&
    a.last_visit === b.last_visit &&
    a.is_supporter === b.is_supporter &&
    a.statistics?.pp === b.statistics?.pp &&
    a.statistics?.play_count === b.statistics?.play_count &&
    a.statistics?.global_rank === b.statistics?.global_rank &&
    a.statistics?.country_rank === b.statistics?.country_rank
  );
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

  const request = fetchLivePlayerProfileSnapshotDirect(username)
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

function loadPlayerAboutCached(userId: number, username: string): Promise<PlayerAboutData> {
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
    .then((section): PlayerAboutData => ({
      html: section?.payload.html ?? null,
      raw: section?.payload.raw ?? null,
    }))
    .finally(() => {
      playerAboutRequestCache.delete(requestKey);
    });

  playerAboutRequestCache.set(requestKey, request);
  return request.then((about) => {
    playerAboutDataCache.set(userId, {
      data: about,
      expiresAt: Date.now() + PLAYER_ABOUT_CLIENT_CACHE_TTL,
    });
    return about;
  });
}

function readCachedPlayerAbout(userId: number): PlayerAboutData | undefined {
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

function PlayerDefaultRoute() {
  const { username } = Route.useParams();
  const loaderData = Route.useLoaderData();
  const location = useLocation();
  return <PlayerProfilePage username={username} loaderData={loaderData} initialTab={getPlayerTabFromPathname(location.pathname)} />;
}

export function PlayerProfilePage({
  username,
  loaderData,
  initialTab,
}: {
  username: string;
  loaderData: PlayerLoaderData;
  initialTab: PlayerTab;
}) {
  const navigate = useNavigate();
  const loaderSnapshot = loaderData?.cachedSnapshot ?? null;
  const loaderBestScores = useMemo(
    () => loaderSnapshot ? dedupeScores(loaderSnapshot.bestScores) : [],
    [loaderSnapshot],
  );
  const [user, setUser] = useState<OsuUser | null>(() => loaderSnapshot?.user ?? null);
  const [best, setBest] = useState<OsuScore[]>(() => loaderBestScores);
  const [recent, setRecent] = useState<OsuScore[]>([]);
  const [aboutHtml, setAboutHtml] = useState<string | null>(null);
  const [aboutRaw, setAboutRaw] = useState<string | null>(null);
  const [aboutEditing, setAboutEditing] = useState(false);
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
  const [tab, setTab] = useState<PlayerTab>(() => normalizePlayerTab(initialTab));
  const [keyFilter, setKeyFilter] = useState<KeyFilter>("all");
  const [bestModFilter, setBestModFilter] = useState<ModFilterState>({});
  const [bestSort, setBestSort] = useState<BestSort>("pp");
  const [bestAgeSort, setBestAgeSort] = useState<BestAgeSort>("newest");
  const [bestWindowLoaded, setBestWindowLoaded] = useState(() => loaderBestScores.length > 0);
  const [waitingForSnapshotBest, setWaitingForSnapshotBest] = useState(() => loaderBestScores.length === 0);
  const [avatarOpen, setAvatarOpen] = useState(false);
  const [modModalOpen, setModModalOpen] = useState(false);
  const [includeNoModUsage, setIncludeNoModUsage] = useState(true);
  const [hoveredMod, setHoveredMod] = useState<string | null>(null);
  const [bpmModalOpen, setBpmModalOpen] = useState(false);
  const [ppModalOpen, setPpModalOpen] = useState(false);
  const [ppDistributionMode, setPpDistributionMode] = useState<PpDistributionMode>("bands");
  const [recentHasMore, setRecentHasMore] = useState(false);
  const [bestVisibleCount, setBestVisibleCount] = useState(INITIAL_SCORE_BATCH_SIZE);
  const [recentVisibleCount, setRecentVisibleCount] = useState(INITIAL_SCORE_BATCH_SIZE);
  const tabsRailRef = useRef<HTMLDivElement | null>(null);
  const loadedProfileKeyRef = useRef<string | null>(null);
  const ppCumulativeDistribution = useMemo(() => buildPpCumulativeDistribution(best), [best]);

  useLayoutEffect(() => {
    const resetScroll = () => window.scrollTo({ top: 0, left: 0, behavior: "auto" });
    resetScroll();

    // TanStack's scroll restoration and mobile Safari's viewport settling both
    // happen around this same frame, so repeat once after layout has committed.
    const frame = window.requestAnimationFrame(resetScroll);
    return () => window.cancelAnimationFrame(frame);
  }, [username]);

  useEffect(() => {
    if (!avatarOpen && !modModalOpen && !bpmModalOpen && !ppModalOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setAvatarOpen(false);
        setModModalOpen(false);
        setBpmModalOpen(false);
        setPpModalOpen(false);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [avatarOpen, modModalOpen, bpmModalOpen, ppModalOpen]);

  useEffect(() => {
    const activeTab = tabsRailRef.current?.querySelector<HTMLButtonElement>(`[data-player-tab="${tab}"]`);
    activeTab?.scrollIntoView({ block: "nearest", inline: "center" });
  }, [tab]);

  useEffect(() => {
    let cancelled = false;
    let snapshotTimer: number | null = null;
    const hasLoaderBestScores = loaderBestScores.length > 0;
    const seededUser = loaderSnapshot?.user ?? readCachedUser(username) ?? readPlayerShell(username);

    // Tab navigation re-runs this effect with the SSR cached snapshot, which
    // can lag the freshly fetched one already on screen (the newest-top-play
    // card would flip back to a stale play). Only re-seed user/best/insights
    // state when the profile itself changed.
    const profileKey = username.trim().toLowerCase();
    const isNewProfile = loadedProfileKeyRef.current !== profileKey;
    loadedProfileKeyRef.current = profileKey;

    if (isNewProfile) {
      setUser(seededUser);
      setBest(loaderBestScores);
      setProfileInsights(hasLoaderBestScores ? calculateUserProfileInsights(loaderBestScores) : null);
      setBestWindowLoaded(hasLoaderBestScores);
      setWaitingForSnapshotBest(!hasLoaderBestScores);
      setLoadingUser(!seededUser);
      setLoadingInsights(!hasLoaderBestScores);
    }
    setRecent([]);
    setAboutHtml(null);
    setTab(normalizePlayerTab(initialTab));
    setKeyFilter("all");
    setBestModFilter({});
    setBestSort("pp");
    setBestAgeSort("newest");
    setUserError(null);
    setBestError(null);
    setRecentError(null);
    setAboutError(null);
    setInsightsError(null);
    setLoadingRecent(false);
    setLoadingAbout(false);
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
      setUser((current) => profileUsersAreEquivalent(current, result.user) ? current : result.user);
      setUserError(null);
      setLoadingUser(false);
      setWaitingForSnapshotBest(false);
      if (result.bestScores.length > 0) {
        const dedupedScores = dedupeScores(result.bestScores);
        setBest((current) => scoreListsAreEquivalent(current, dedupedScores) ? current : dedupedScores);
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
  }, [initialTab, loaderBestScores, loaderSnapshot, username]);

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
          setBest((current) => scoreListsAreEquivalent(current, dedupedScores) ? current : dedupedScores);
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
      setAboutRaw(user.page.raw ?? null);
      return;
    }
    const cachedAbout = readCachedPlayerAbout(user.id);
    if (cachedAbout !== undefined) {
      setAboutHtml(cachedAbout.html);
      setAboutRaw(cachedAbout.raw);
      return;
    }

    let cancelled = false;
    setLoadingAbout(true);
    setAboutError(null);

    loadPlayerAboutCached(user.id, user.username)
      .then((about) => {
        if (cancelled) return;
        setAboutHtml(about.html);
        setAboutRaw(about.raw);
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
  const cachedAboutFallback = user ? readCachedPlayerAbout(user.id) : undefined;
  const displayedAboutHtml = aboutHtml ?? cachedAboutFallback?.html;
  const displayedAboutRaw = aboutRaw ?? cachedAboutFallback?.raw ?? null;
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

  const handleTabChange = useCallback((nextTab: PlayerTab) => {
    const normalizedTab = normalizePlayerTab(nextTab);
    setTab(normalizedTab);
    void navigate({ to: getPlayerTabPath(username, normalizedTab), resetScroll: false });
  }, [navigate, username]);

  const handleBestSortChange = useCallback((nextSort: BestSort) => {
    setBestSort(nextSort);
    if (nextSort !== "pp") setBestAgeSort(nextSort);
  }, []);

  if (loadingUser && !user) {
    return <PlayerPageSkeleton tab={tab} onTabChange={handleTabChange} />;
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

      {/* PP distribution modal */}
      <AnimatePresence>
        {ppModalOpen && profileInsights?.ppRange && profileInsights.ppDistribution.length > 0 && (
          <motion.div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 sm:backdrop-blur-sm cursor-pointer p-4"
            onClick={() => setPpModalOpen(false)}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
          >
            <motion.div
              role="dialog"
              aria-modal="true"
              aria-label="PP distribution"
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
                onClick={() => setPpModalOpen(false)}
                aria-label="Close"
                className="absolute top-3 right-3 z-20 w-7 h-7 flex items-center justify-center rounded-full text-osu-f1 hover:text-white hover:bg-osu-b3/50 transition-colors cursor-pointer"
              >
                <X size={14} />
              </button>
              <div className="relative z-10 max-h-[85vh] overflow-y-auto p-5 [scrollbar-gutter:stable]">
                {(() => {
                  const ppDistribution = profileInsights.ppDistribution;
                  const ppTotal = ppDistribution[0]?.total ?? profileInsights.sampleSize;
                  const showCumulative = ppDistributionMode === "cumulative" && ppCumulativeDistribution.length > 0;
                  const ppRows = showCumulative
                    ? ppCumulativeDistribution.map((entry, index) => ({
                        key: `cumulative:${entry.threshold}`,
                        label: formatPpCumulativeDistributionLabel(entry.threshold),
                        count: entry.count,
                        total: entry.total,
                        color: getPpDistributionColor(index, false),
                      }))
                    : ppDistribution.map((entry, index) => ({
                        key: `${entry.min ?? "below"}:${entry.max ?? "up"}`,
                        label: formatPpDistributionLabel(entry),
                        count: entry.count,
                        total: ppTotal,
                        color: getPpDistributionColor(index, entry.min == null),
                      }));

                  return (
                    <>
                      <div className="pr-8 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                        <div>
                          <div className="text-[10px] uppercase tracking-wider text-osu-f1 font-semibold">PP Distribution</div>
                          <div className="mt-0.5 text-[11px] text-osu-f1/60">
                            across {ppTotal} profile top plays with PP
                          </div>
                        </div>
                        <div className="inline-flex w-fit items-center gap-0.5 rounded-lg border border-osu-b3/20 bg-osu-b4/60 p-0.5">
                          {(["bands", "cumulative"] as const).map((mode) => {
                            const active = ppDistributionMode === mode;
                            return (
                              <button
                                key={mode}
                                type="button"
                                onClick={() => setPpDistributionMode(mode)}
                                aria-pressed={active}
                                className={`rounded-md px-2 py-1 text-[10px] font-semibold transition-colors cursor-pointer ${active
                                  ? "bg-osu-pink/15 text-osu-pink-light"
                                  : "text-osu-f1 hover:bg-osu-b3/40 hover:text-osu-l2"
                                }`}
                              >
                                {mode === "bands" ? "Bands" : "Cumulative"}
                              </button>
                            );
                          })}
                        </div>
                      </div>

                      <div className="mt-4 flex flex-wrap items-baseline gap-x-2 gap-y-1">
                        <span className="text-2xl font-bold text-osu-pink-light tabular-nums">{Math.round(profileInsights.ppRange.top)}</span>
                        <span className="text-[11px] text-osu-f1">top pp</span>
                        <span className="text-osu-f1/40">/</span>
                        <span className="text-xl font-bold text-white tabular-nums">{Math.round(profileInsights.ppRange.bottom)}</span>
                        <span className="text-[11px] text-osu-f1">bottom pp</span>
                      </div>

                      <div className="mt-4 space-y-2">
                        {ppRows.map((entry) => {
                          const pct = entry.total > 0 ? (entry.count / entry.total) * 100 : 0;
                          const fillWidth = entry.count > 0 ? Math.max(4, pct) : 0;

                          return (
                            <div key={entry.key} className="rounded-lg px-2.5 py-2 transition-colors hover:bg-osu-b3/25">
                              <div className="flex items-center justify-between gap-3">
                                <div className="flex items-baseline gap-1.5">
                                  <span className="text-sm font-bold text-white tabular-nums">{entry.label}</span>
                                  <span className="text-[10px] text-osu-f1">pp</span>
                                </div>
                                <div className="flex items-baseline gap-1.5 tabular-nums">
                                  <span className="text-sm font-bold text-white">{entry.count}</span>
                                  <span className="text-[10px] text-osu-f1">{entry.count === 1 ? "play" : "plays"}</span>
                                  <span className="text-[10px] text-osu-f1/60">({formatPpDistributionPercent(entry.count, entry.total)})</span>
                                </div>
                              </div>
                              <div className="mt-1.5 h-1.5 rounded-full bg-osu-b3/40 overflow-hidden">
                                <div
                                  className="h-full rounded-full"
                                  style={{ width: `${fillWidth}%`, backgroundColor: entry.color }}
                                />
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </>
                  );
                })()}
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
                {user.is_online ? (
                  <span className="w-2 h-2 rounded-full bg-osu-green" title="Online" />
                ) : user.last_visit ? (
                  <span
                    className="text-[11px] text-osu-l2"
                    title={new Date(user.last_visit).toLocaleString()}
                  >
                    Last seen {formatDetailedTimeAgo(user.last_visit)}
                  </span>
                ) : null}
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
            <CompactStat label="Play Time" value={profileStatsProjectedOnly || stats.play_time == null ? "-" : `${formatNumber(Math.floor(stats.play_time / 3600))}h`} />
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
              const hasPpDistribution = profileInsights.ppRange != null && profileInsights.ppDistribution.length > 0;
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
                  <button
                    type="button"
                    className={`bg-osu-b4 rounded-xl p-3.5 border border-osu-b3/20 min-h-[90px] w-full text-left group focus:outline-none focus-visible:border-osu-pink/60 focus-visible:ring-2 focus-visible:ring-osu-pink/25 ${hasPpDistribution ? "cursor-pointer hover:border-osu-b3/50 transition-colors" : "cursor-default"}`}
                    onClick={hasPpDistribution ? () => setPpModalOpen(true) : undefined}
                    disabled={!hasPpDistribution}
                  >
                    <div className="flex items-center justify-between">
                      <div className="text-[9px] uppercase tracking-wider text-osu-f1 font-semibold">PP Range</div>
                      {hasPpDistribution && <ExpandHint />}
                    </div>
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
                  </button>
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
          <div className="mt-5 pt-1 border-t border-osu-b3/30 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div ref={tabsRailRef} className="-mx-5 overflow-x-auto px-5 scrollbar-hide sm:mx-0 sm:px-0">
              <div className="flex min-w-max">
                {PLAYER_TABS.map((t) => (
                  <button
                    key={t}
                    data-player-tab={t}
                    onClick={() => handleTabChange(t)}
                    className={`shrink-0 whitespace-nowrap px-4 py-2.5 text-[12px] font-medium cursor-pointer transition-colors duration-[120ms] capitalize ${tab === t
                        ? "text-osu-c1 border-b-2 border-osu-h1"
                        : "text-osu-f1 hover:text-osu-l2"
                      }`}
                  >
                    {getPlayerTabLabel(t)}
                  </button>
                ))}
              </div>
            </div>
            {(tab === "best" || tab === "recent") && availableKeyModes.length > 1 && (
              <div className="hidden lg:block">
                <KeyModeControl
                  availableKeyModes={availableKeyModes}
                  keyFilter={keyFilter}
                  onChangeKeyFilter={setKeyFilter}
                />
              </div>
            )}
          </div>

          {tab === "best" && bestWindowLoaded && best.length > 0 && (
            <BestScoresControlBar
              availableKeyModes={availableKeyModes}
              keyFilter={keyFilter}
              onChangeKeyFilter={setKeyFilter}
              mods={relevantBestMods}
              modFilter={bestModFilter}
              onCycleMod={cycleBestMod}
              onReverseCycleMod={reverseCycleBestMod}
              onClearMods={() => setBestModFilter({})}
              sort={bestSort}
              ageSort={bestAgeSort}
              onChangeSort={handleBestSortChange}
            />
          )}
          {tab === "recent" && availableKeyModes.length > 1 && (
            <div className="mt-3 lg:hidden">
              <KeyModeControl
                availableKeyModes={availableKeyModes}
                keyFilter={keyFilter}
                onChangeKeyFilter={setKeyFilter}
              />
            </div>
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
                {aboutEditing && user ? (
                  <Suspense
                    fallback={(
                      <div className="space-y-2 rounded-xl bg-osu-b4 border border-osu-b3/20 p-5">
                        <Skeleton className="h-4 w-40" />
                        <Skeleton className="h-4 w-full" />
                        <Skeleton className="h-4 w-2/3" />
                      </div>
                    )}
                  >
                    <BBCodeEditorLazy
                      userId={user.id}
                      username={user.username}
                      initialSource={displayedAboutRaw}
                      onClose={() => setAboutEditing(false)}
                    />
                  </Suspense>
                ) : loadingAbout ? (
                  <div className="space-y-2 rounded-xl bg-osu-b4 border border-osu-b3/20 p-5">
                    <Skeleton className="h-4 w-40" />
                    <Skeleton className="h-4 w-full" />
                    <Skeleton className="h-4 w-2/3" />
                  </div>
                ) : aboutError ? (
                  <div className="text-center py-8 text-osu-f1 text-sm">{aboutError}</div>
                ) : displayedAboutHtml ? (
                  <PlayerAboutCard html={displayedAboutHtml} onEdit={() => setAboutEditing(true)} />
                ) : (
                  <div className="text-center py-8 text-osu-f1 text-sm space-y-3">
                    <div>No About content found.</div>
                    <button
                      type="button"
                      onClick={() => setAboutEditing(true)}
                      className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-osu-b4 text-[12px] font-semibold text-osu-l2 border border-osu-b3/30 hover:bg-osu-b3 transition-colors cursor-pointer"
                    >
                      <Pencil size={13} />
                      Write one in the BBCode editor
                    </button>
                  </div>
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
            ) : tab === "activity" ? (
              <motion.div
                key="activity"
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.14 }}
              >
                <PlayerActivityPanel user={user} />
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

          {tab !== "about" && tab !== "card" && tab !== "activity" && !loadingScores && !scoresError && canShowMore && (
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
          <div className="-mx-5 overflow-x-auto px-5 scrollbar-hide sm:mx-0 sm:px-0">
            <div className="flex min-w-max">
              {PLAYER_TABS.map((t) => (
                <button
                  key={t}
                  onClick={() => onTabChange(t)}
                  className={`shrink-0 whitespace-nowrap px-4 py-2.5 text-[12px] font-medium cursor-pointer transition-colors duration-[120ms] capitalize ${tab === t
                      ? "text-osu-c1 border-b-2 border-osu-h1"
                      : "text-osu-f1 hover:text-osu-l2"
                    }`}
                >
                  {getPlayerTabLabel(t)}
                </button>
              ))}
            </div>
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

function PlayerActivityPanel({ user }: { user: OsuUser }) {
  const currentYear = new Date().getFullYear();
  const [selectedYear, setSelectedYear] = useState(currentYear);
  const [selectedDay, setSelectedDay] = useState<ActivityDay | null>(null);
  // Dev-only simulated day; kept out of selectedDay so the day-sync and
  // detail-fetch effects below never race it against real backend data.
  const [devDay, setDevDay] = useState<ActivityDay | null>(null);
  const [selectedDayDetail, setSelectedDayDetail] = useState<ActivityDay | null>(null);
  const [dayDetailLoading, setDayDetailLoading] = useState(false);
  const [dayDetailError, setDayDetailError] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<LivePlayerActivitySnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const activity = useMemo(() => buildActivityFromSnapshot(snapshot, selectedYear), [selectedYear, snapshot]);
  const yearOptions = useMemo(() => {
    const years = new Set([currentYear, selectedYear, ...activity.availableYears]);
    return [...years].sort((a, b) => b - a);
  }, [activity.availableYears, currentYear, selectedYear]);
  const averageActiveDay = activity.activeDays > 0 ? Math.round(activity.totalScores / activity.activeDays) : 0;
  const selectedDayDate = selectedDay?.date;
  const modalDay = devDay ?? (selectedDayDetail?.date === selectedDayDate ? selectedDayDetail : selectedDay);
  const closeDayModal = useCallback(() => {
    setSelectedDay(null);
    setDevDay(null);
  }, []);
  const activityGridStyle = useMemo(
    () => ({ "--activity-weeks": String(activity.weeks.length) }) as CSSProperties,
    [activity.weeks.length],
  );

  useEffect(() => {
    if (!isLiveBackendConfigured()) {
      setLoading(false);
      setSnapshot(null);
      setError("Activity is only available when the server is configured.");
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    fetchLivePlayerActivityDirect(user.id, PLAYER_ACTIVITY_COUNTRY_SCOPE, selectedYear)
      .then((nextSnapshot) => {
        if (cancelled) return;
        setSnapshot(nextSnapshot);
      })
      .catch(() => {
        if (cancelled) return;
        setSnapshot(null);
        setError("Couldn't load Activity right now.");
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [selectedYear, user.id]);

  useEffect(() => {
    if (!selectedDayDate) return;
    setSelectedDay(activity.days.find((day) => day.date === selectedDayDate) ?? null);
  }, [activity, selectedDayDate]);

  useEffect(() => {
    if (!selectedDayDate) {
      setSelectedDayDetail(null);
      setDayDetailLoading(false);
      setDayDetailError(null);
      return;
    }

    let cancelled = false;
    setSelectedDayDetail(null);
    setDayDetailLoading(true);
    setDayDetailError(null);

    fetchLivePlayerActivityDayDirect(user.id, PLAYER_ACTIVITY_COUNTRY_SCOPE, selectedDayDate)
      .then((day) => {
        if (cancelled) return;
        setSelectedDayDetail(normalizeActivityDay(day, activity.typicalSession));
      })
      .catch(() => {
        if (cancelled) return;
        setDayDetailError("Couldn't load the full day detail.");
      })
      .finally(() => {
        if (cancelled) return;
        setDayDetailLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [activity.typicalSession, selectedDayDate, user.id]);

  if (loading && !snapshot) {
    return (
      <div className="space-y-4 py-2">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-2">
            <Skeleton className="h-7 w-44" />
            <Skeleton className="h-3 w-36" />
          </div>
          <Skeleton className="h-10 w-28" />
        </div>
        <div className="grid grid-cols-[32px_minmax(0,1fr)] gap-2">
          <Skeleton className="h-32 w-8" />
          <Skeleton className="h-32 w-full" />
        </div>
      </div>
    );
  }

  if (error && !snapshot) {
    return (
      <div className="rounded-xl border border-osu-b3/20 bg-osu-b4 p-5 text-center text-sm text-osu-f1">
        {error}
      </div>
    );
  }

  if (snapshot && !snapshot.available) {
    return (
      <div className="rounded-xl border border-osu-b3/20 bg-osu-b4 p-6 text-center">
        <div className="text-sm font-semibold text-osu-l2">No activity data for this player</div>
        <div className="mt-1.5 text-[13px] text-osu-f1">
          Plays are only recorded for the top 100 players of each tracked country, and this player isn't currently among them.
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_130px]">
        <section className="min-w-0 px-1 py-2 sm:px-0">
          <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
            <div>
              <h2 className="text-xl font-semibold text-white">
                {formatNumber(activity.totalScores)} plays in {selectedYear}
              </h2>
            </div>
            <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
              <ActivityInlineMetric label="Avg active day" value={formatNumber(averageActiveDay)} detail="plays" />
              <ActivityInlineMetric label="Streak" value={`${activity.currentStreak}d`} detail="now" />
            </div>
          </div>

          <div className="mt-6 sm:mt-7">
            <div className="flex gap-2">
              {/* Row pitch must match the cells: fixed 12px rows on mobile (cells are
                  12px), 1fr rows on sm+ where pt-5 equals the month-label row (h-3 +
                  mt-2) so the stretched height equals the heatmap grid exactly. */}
              <div className="grid w-8 shrink-0 grid-rows-[repeat(7,12px)] gap-1 pt-5 text-[10px] leading-none text-osu-f1 sm:grid-rows-7">
                {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day) => (
                  <span key={day} className="flex items-center">{day}</span>
                ))}
              </div>
              <div className="min-w-0 max-w-full flex-1 overflow-x-auto pb-2 scrollbar-hide sm:overflow-visible sm:pb-0">
                <div className="w-max sm:w-full">
                  <ActivityMonthLabels weeks={activity.weeks} gridStyle={activityGridStyle} />
                  <div
                    className="activity-heatmap-grid mt-2 grid gap-1"
                    style={activityGridStyle}
                  >
                    {activity.weeks.map((week) => (
                      <div key={week.key} className="grid min-w-0 grid-rows-7 gap-1">
                        {week.days.map((day, index) => (
                          day ? (
                            day.scoreCount > 0 ? (
                              <button
                                key={day.date}
                                type="button"
                                title={`${formatFullActivityDate(day.date)}: ${day.scoreCount} plays, ${day.sessionCount} sessions`}
                                onClick={() => setSelectedDay(day)}
                                className="aspect-square w-full min-w-0 rounded-[3px] border transition-transform hover:scale-125 hover:ring-2 hover:ring-osu-pink/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-osu-pink/90"
                                style={getActivityCellStyle(day, activity.typicalSession)}
                              />
                            ) : (
                              <span
                                key={day.date}
                                title={`${formatFullActivityDate(day.date)}: no tracked plays`}
                                className={`aspect-square w-full min-w-0 rounded-[3px] border ${ACTIVITY_EMPTY_CELL_CLASS}`}
                              />
                            )
                          ) : (
                            <span key={`empty-${index}`} className="aspect-square w-full min-w-0" />
                          )
                        ))}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
            <span className="text-[11px] text-osu-f1">
              Typical session <span className="font-semibold text-osu-l2">{activity.typicalSession} plays</span>
            </span>
            {import.meta.env.DEV && (
              <button
                type="button"
                onClick={() => setDevDay(createDevActivityDay(activity.timezone))}
                className="rounded-lg border border-osu-pink/25 bg-osu-pink/10 px-2 py-1 text-[10px] font-semibold text-osu-pink-light transition-colors hover:bg-osu-pink/20"
                title="Open the day modal with simulated busy-day data"
              >
                Sim busy day
              </button>
            )}
          </div>
        </section>

        <div className="flex gap-2 overflow-x-auto scrollbar-hide lg:block lg:space-y-2 lg:overflow-visible">
          {yearOptions.map((year) => (
            <button
              key={year}
              type="button"
              onClick={() => {
                setSelectedYear(year);
                setSelectedDay(null);
              }}
              className={`min-w-24 rounded-lg px-4 py-2 text-left text-sm font-semibold transition-colors lg:w-full ${selectedYear === year
                  ? "bg-osu-pink text-white"
                  : "bg-osu-b4/60 text-osu-f1 hover:bg-osu-b3/55 hover:text-osu-l2"
                }`}
            >
              {year}
            </button>
          ))}
        </div>
      </div>

      <AnimatePresence>
        {modalDay && (
          <motion.div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-2 backdrop-blur-sm sm:p-4"
            onClick={closeDayModal}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.14 }}
          >
            <motion.div
              className="flex max-h-[calc(100dvh-1rem)] w-full max-w-[34rem] flex-col overflow-hidden rounded-xl border border-osu-b3/25 bg-osu-b4 p-4 shadow-[0_18px_70px_rgba(0,0,0,0.55)] sm:max-h-[calc(100vh-2rem)] sm:max-w-xl sm:p-5"
              onClick={(event) => event.stopPropagation()}
              initial={{ opacity: 0, y: 10, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 8, scale: 0.97 }}
              transition={{ duration: 0.16 }}
            >
              <div className="flex shrink-0 items-start justify-between gap-4">
                <div>
                  <div className="text-[9px] font-black uppercase tracking-wide text-osu-pink-light sm:text-[10px]">Activity day</div>
                  <h3 className="mt-1 text-xl font-black text-white sm:text-2xl">{formatFullActivityDate(modalDay.date)}</h3>
                </div>
                <button
                  type="button"
                  onClick={closeDayModal}
                  aria-label="Close activity details"
                  className="flex h-8 w-8 items-center justify-center rounded-full text-osu-f1 hover:bg-osu-b3/50 hover:text-white"
                >
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <path d="M1 1l12 12M13 1L1 13" />
                  </svg>
                </button>
              </div>

              <div className="min-h-0 overflow-y-auto pr-1 [scrollbar-gutter:stable]">
                <div className="mt-4 grid grid-cols-2 gap-2 sm:mt-5">
                  <ActivityDetailMetric label="Plays" value={formatNumber(modalDay.scoreCount)} />
                  <ActivityDetailMetric label="Sessions" value={formatNumber(modalDay.sessionCount)} />
                </div>

                <ActivitySessionFlow day={modalDay} timezone={activity.timezone} />

                <div className="mt-4 rounded-lg border border-osu-b3/20 bg-osu-b5/35 p-3 sm:mt-5 sm:p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-[11px] font-bold uppercase text-osu-f1 sm:text-xs">Maps played</div>
                    <div className="text-[10px] text-osu-f1 sm:text-[11px]">
                      {dayDetailLoading
                        ? "loading"
                        : modalDay.mapCount > modalDay.maps.length
                          ? `${modalDay.maps.length} of ${modalDay.mapCount}`
                          : `${modalDay.maps.length} ${modalDay.maps.length === 1 ? "map" : "maps"}`}
                    </div>
                  </div>
                  <div className="mt-2 max-h-52 space-y-1.5 overflow-y-auto overscroll-contain pr-1 sm:mt-3 sm:max-h-64 sm:space-y-2">
                    {dayDetailLoading && modalDay.maps.length === 0 ? (
                      <>
                        <Skeleton className="h-16 rounded-md" />
                        <Skeleton className="h-16 rounded-md" />
                        <Skeleton className="h-16 rounded-md" />
                      </>
                    ) : (
                      modalDay.maps.map((map) => (
                        <ActivityMapRow key={map.key} map={map} />
                      ))
                    )}
                    {dayDetailError ? (
                      <div className="rounded-md bg-osu-b4/70 px-3 py-2 text-[11px] text-osu-f1">
                        {dayDetailError}
                      </div>
                    ) : null}
                  </div>
                </div>

                <div className="mt-4 rounded-lg border border-osu-b3/20 bg-osu-b5/35 p-3 sm:mt-5 sm:p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-[11px] font-bold uppercase text-osu-f1 sm:text-xs">Day pattern mix</div>
                    <div className="text-[10px] text-osu-f1 sm:text-[11px]">by keymode</div>
                  </div>
                  {modalDay.skills && modalDay.skills.analyzedPlays > 0 ? (
                    <ActivityPatternMix skills={modalDay.skills} />
                  ) : dayDetailLoading ? (
                    <div className="mt-3 space-y-2">
                      <Skeleton className="h-3 rounded-full" />
                      <Skeleton className="h-3 rounded-full" />
                      <Skeleton className="h-3 rounded-full" />
                      <Skeleton className="h-3 rounded-full" />
                    </div>
                  ) : (
                    <div className="mt-3 text-[11px] text-osu-f1">
                      Skill analysis is queued for the maps played on this day.
                    </div>
                  )}
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

function ActivityDetailMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-osu-b3/20 bg-osu-b5/45 px-3 py-2">
      <div className="text-[10px] font-bold uppercase text-osu-f1">{label}</div>
      <div className="mt-1 text-lg font-black text-white sm:text-xl">{value}</div>
    </div>
  );
}

function ActivityPatternMix({ skills }: { skills: ActivitySkillReadout }) {
  const keyModes = skills.keyModes.length > 0
    ? skills.keyModes
    : [{
      keyCount: null,
      patterns: skills.patterns,
      analyzedPlays: skills.analyzedPlays,
      totalPlays: skills.totalPlays,
    }];
  return (
    <div className="mt-3 space-y-3">
      {keyModes.map((keyMode, index) => (
        <div key={`${keyMode.keyCount ?? "unknown"}:${index}`} className="rounded-md bg-osu-b4/45 p-2">
          <div className="mb-2 flex items-center justify-between gap-3 text-[10px]">
            <span className="font-black text-osu-l2">{formatActivityKeyCount(keyMode.keyCount) ?? "Unknown keys"}</span>
            <span className="text-osu-f1">
              {formatNumber(keyMode.analyzedPlays)} {keyMode.analyzedPlays === 1 ? "play" : "plays"}
            </span>
          </div>
          <ActivityPatternBars patterns={keyMode.patterns} keyCount={keyMode.keyCount} />
          {keyMode.analyzedPlays < keyMode.totalPlays && (
            <div className="pt-1 text-[10px] text-osu-f1">
              {formatNumber(keyMode.analyzedPlays)} of {formatNumber(keyMode.totalPlays)} plays analyzed
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function ActivityPatternBars({ patterns, keyCount }: { patterns: LivePlayerActivityPatterns; keyCount: number | null }) {
  return (
    <div className="space-y-2">
      {getActivityPatternEntries(patterns, keyCount).slice(0, 6).map(({ key, label, value }) => (
        <div key={key}>
          <div className="mb-1 flex justify-between text-[11px]">
            <span className="font-semibold text-osu-l2">{label}</span>
            <span className="text-osu-f1">{value}%</span>
          </div>
          <div className="h-1.5 rounded-full bg-osu-b3/35">
            <div
              className="h-full rounded-full"
              style={{ width: `${value}%`, backgroundColor: getActivitySkillColor(key) }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

function ActivitySessionFlow({ day, timezone }: { day: ActivityDay; timezone: string }) {
  const [selectedSegmentKey, setSelectedSegmentKey] = useState<string | null>(null);
  if (day.timeline.length === 0) return null;
  const sessions = groupActivityTimelineBySession(day.timeline).map(mergeActivitySessionSegments);
  const flowLabel = formatActivityKeyFlow(day.timeline);
  const timezoneHint = getActivityTimezoneHint(timezone, day.timeline[0]?.startAt);
  const showKeymodeStrip = new Set(day.timeline.map((segment) => segment.keyCount ?? 0)).size > 1;
  const legend = getActivityFlowLegend(day.timeline);
  return (
    <div className="mt-4 rounded-lg border border-osu-b3/20 bg-osu-b5/35 p-3 sm:mt-5 sm:p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="text-[11px] font-bold uppercase text-osu-f1 sm:text-xs">
          Session flow
          {timezoneHint ? <span className="ml-1.5 font-semibold normal-case text-osu-f1/70">{timezoneHint}</span> : null}
        </div>
        <div className="text-[10px] font-semibold text-osu-l2 sm:text-[11px]">{flowLabel}</div>
      </div>
      <div className="mt-3 space-y-2.5">
        {sessions.map((session) => {
          const sessionPlays = session.reduce((sum, segment) => sum + segment.playCount, 0);
          const first = session[0];
          const last = session[session.length - 1];
          const startDateLabel = formatActivitySessionDate(first.startAt, day.date, timezone);
          const selected = session.find((segment) => segment.key === selectedSegmentKey) ?? null;
          return (
            <div key={first.key}>
              <div className="mb-1 flex items-center justify-between gap-3 text-[10px] text-osu-f1">
                <span>
                  {startDateLabel ? <span className="font-semibold text-osu-l2">{startDateLabel} · </span> : null}
                  {formatActivityTime(first.startAt, timezone)} - {formatActivityTime(last.endAt, timezone)}
                </span>
                <span>{formatNumber(sessionPlays)} {sessionPlays === 1 ? "play" : "plays"}</span>
              </div>
              <div className="flex h-7 overflow-hidden rounded-md bg-osu-b4/70">
                {session.map((segment) => {
                  const isSelected = segment.key === selectedSegmentKey;
                  return (
                    <button
                      key={segment.key}
                      type="button"
                      title={formatActivitySegmentTitle(segment, timezone)}
                      onClick={() => setSelectedSegmentKey(isSelected ? null : segment.key)}
                      className={`flex min-w-0 items-center justify-center border-r border-black/20 px-1 last:border-r-0 ${isSelected ? "ring-1 ring-inset ring-white/80" : ""}`}
                      style={{
                        flexBasis: 0,
                        flexGrow: Math.max(1, segment.playCount),
                        backgroundColor: getActivityTimelineSegmentColor(segment),
                      }}
                    >
                      {segment.playCount / sessionPlays >= 0.08 ? (
                        <span className="truncate text-[9px] font-black leading-none text-white/95">
                          {formatActivityFlowSegmentLabel(segment)}
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
              {showKeymodeStrip ? (
                <div className="mt-1 flex">
                  {groupActivityKeymodeRuns(session).map((run) => {
                    const label = formatActivityKeyCount(run.keyCount);
                    return (
                      <div
                        key={run.key}
                        className="flex min-w-0 items-center gap-1 overflow-hidden px-1"
                        style={{ flexBasis: 0, flexGrow: run.weight }}
                      >
                        <span className="h-px min-w-1 flex-1 bg-osu-b3/60" />
                        {label ? <span className="text-[8px] font-bold leading-none text-osu-f1">{label}</span> : null}
                        <span className="h-px min-w-1 flex-1 bg-osu-b3/60" />
                      </div>
                    );
                  })}
                </div>
              ) : null}
              {selected ? (
                <div className="mt-1.5 flex items-center gap-1.5 text-[10px] text-osu-f1">
                  <span
                    className="h-2 w-2 shrink-0 rounded-[2px]"
                    style={{ backgroundColor: getActivityTimelineSegmentColor(selected) }}
                  />
                  <span>{formatActivitySegmentTitle(selected, timezone)}</span>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
      {legend.length > 0 ? (
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-osu-f1">
          {legend.slice(0, 5).map((entry) => (
            <span key={entry.label} className="flex items-center gap-1">
              <span className="h-2 w-2 rounded-[2px]" style={{ backgroundColor: entry.color }} />
              <span className="font-semibold text-osu-l2">{entry.label}</span>
              <span>{formatNumber(entry.plays)}</span>
            </span>
          ))}
          {legend.length > 5 ? <span>+ {legend.length - 5} more</span> : null}
        </div>
      ) : null}
    </div>
  );
}

function ActivityMapRow({ map }: { map: ActivityPlayedMap }) {
  return (
    <a
      href={`https://osu.ppy.sh/beatmaps/${map.beatmapId}`}
      target="_blank"
      rel="noreferrer"
      className="grid grid-cols-[42px_minmax(0,1fr)_2.25rem] items-center gap-2 rounded-md bg-osu-b4/70 px-2 py-1.5 transition-colors hover:bg-osu-b3/45 sm:grid-cols-[48px_minmax(0,1fr)_auto] sm:gap-3 sm:rounded-lg sm:p-2"
    >
      {map.coverUrl ? (
        <img
          src={map.coverUrl}
          alt=""
          className="h-8 w-[42px] rounded object-cover sm:h-9 sm:w-12"
          loading="lazy"
        />
      ) : (
        <div className="flex h-8 w-[42px] items-center justify-center rounded bg-osu-b3/60 text-xs font-black text-osu-l2 sm:h-9 sm:w-12">
          {map.title.slice(0, 1).toUpperCase()}
        </div>
      )}
      <div className="min-w-0">
        <div className="truncate text-[13px] font-bold text-white sm:text-sm">{map.title}</div>
        <div className="truncate text-[10px] text-osu-f1 sm:text-[11px]">
          {map.artist} [{map.version}]
        </div>
        <div className="mt-0.5 flex flex-wrap gap-x-2 gap-y-0.5 text-[10px] text-osu-f1">
          {map.keyCount ? <span>{map.keyCount}K</span> : null}
          {map.accuracy != null ? <span>{formatAccuracy(map.accuracy)}</span> : null}
          {map.pp != null ? <span>{formatPP(map.pp)}</span> : null}
        </div>
        <ActivityMapPatternPills skills={map.skills} keyCount={map.keyCount} />
      </div>
      <div className="text-right">
        <div className="text-[13px] font-black text-osu-l2 sm:text-sm">{formatNumber(map.plays)}</div>
        <div className="text-[10px] text-osu-f1">{map.plays === 1 ? "play" : "plays"}</div>
      </div>
    </a>
  );
}

function ActivityMapPatternPills({ skills, keyCount }: { skills: LivePlayerActivitySkillVector | null; keyCount: number | null }) {
  if (!skills) return null;
  const primary = getActivityPrimarySkill(skills);
  const entries = getActivityPatternEntries(skills.patterns, keyCount).slice(0, 5);
  return (
    <div className="mt-1 flex flex-wrap gap-1">
      {entries.map(({ key, shortLabel, value }) => {
        const active = primary === key || primary === "mixed";
        return (
          <span
            key={key}
            className={`rounded px-1 py-0.5 text-[9px] font-black leading-none ${active ? "text-white" : "text-osu-f1"}`}
            style={{
              backgroundColor: active ? getActivitySkillColor(key) : "rgba(255,255,255,0.06)",
            }}
          >
            {shortLabel} {value}
          </span>
        );
      })}
    </div>
  );
}

function ActivityInlineMetric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="min-w-20 border-l border-osu-b3/30 pl-4 first:border-l-0 first:pl-0">
      <div className="text-[10px] font-bold uppercase text-osu-f1">{label}</div>
      <div className="text-lg font-black leading-tight text-white">{value}</div>
      <div className="text-[10px] text-osu-f1">{detail}</div>
    </div>
  );
}

function ActivityMonthLabels({ weeks, gridStyle }: { weeks: ActivityWeek[]; gridStyle: CSSProperties }) {
  let lastMonth = "";
  return (
    <div
      className="activity-heatmap-grid grid h-3 gap-1 text-[10px] leading-none text-osu-f1"
      style={gridStyle}
    >
      {weeks.map((week) => {
        const firstDay = week.days.find((day): day is ActivityDay => day != null);
        const month = firstDay ? formatActivityMonth(firstDay.date) : "";
        const label = month && month !== lastMonth ? month : "";
        if (month) lastMonth = month;
        return (
          <span key={week.key} className="min-w-0 whitespace-nowrap">
            {label}
          </span>
        );
      })}
    </div>
  );
}

function buildActivityFromSnapshot(snapshot: LivePlayerActivitySnapshot | null, year: number): ActivitySummary {
  const today = startOfLocalDay(new Date());
  const { start, end } = getActivityHeatmapRange(snapshot, year);
  const activeDays = new Map((snapshot?.days ?? []).map((day) => [day.date, day]));
  const typicalSession = Math.max(1, snapshot?.typicalSession ?? 1);
  const days: ActivityDay[] = [];

  for (let date = startOfLocalDay(start); date <= end; date = addLocalDays(date, 1)) {
    const dateKey = toDateKey(date);
    const active = activeDays.get(dateKey);
    const scoreCount = active?.scoreCount ?? 0;

    days.push(normalizeActivityDay({
      date: dateKey,
      scoreCount,
      passedCount: active?.passedCount ?? 0,
      sessionCount: active?.sessionCount ?? 0,
      mapCount: active?.mapCount ?? active?.maps.length ?? 0,
      maps: active?.maps ?? [],
      skills: active?.skills ?? null,
      timeline: active?.timeline ?? [],
    }, typicalSession));
  }

  const weeks = buildActivityWeeks(days);

  return {
    days,
    weeks,
    totalScores: snapshot?.totalScores ?? 0,
    activeDays: snapshot?.activeDays ?? 0,
    totalSessions: snapshot?.totalSessions ?? 0,
    currentStreak: snapshot?.currentStreak ?? 0,
    typicalSession,
    availableYears: snapshot?.availableYears ?? [today.getFullYear()],
    timezone: snapshot?.timezone ?? "UTC",
  };
}

// Skip the empty months before a player's first tracked play: the heatmap
// starts at the first active month and always runs through December.
function getActivityHeatmapRange(
  snapshot: LivePlayerActivitySnapshot | null,
  year: number,
): { start: Date; end: Date } {
  const firstActiveDate = (snapshot?.days ?? [])
    .filter((day) => day.scoreCount > 0)
    .map((day) => day.date)
    .sort()[0];
  const first = firstActiveDate ? parseLocalDateKey(firstActiveDate) : new Date(year, 0, 1);
  return {
    start: new Date(first.getFullYear(), first.getMonth(), 1),
    end: new Date(year, 11, 31),
  };
}

function normalizeActivityDay(day: Omit<ActivityDay, "level">, typicalSession: number): ActivityDay {
  return {
    ...day,
    level: getActivityLevel(day.scoreCount, typicalSession),
  };
}

function buildActivityWeeks(days: ActivityDay[]): ActivityWeek[] {
  const weeks: ActivityWeek[] = [];
  let current: (ActivityDay | null)[] = [];

  const leadingBlanks = days[0] ? parseLocalDateKey(days[0].date).getDay() : 0;
  for (let index = 0; index < leadingBlanks; index++) current.push(null);

  for (const day of days) {
    current.push(day);
    if (current.length === 7) {
      weeks.push({ key: day.date, days: current });
      current = [];
    }
  }

  if (current.length > 0) {
    const key = current.find((day): day is ActivityDay => day != null)?.date ?? `week-${weeks.length}`;
    while (current.length < 7) current.push(null);
    weeks.push({ key, days: current });
  }

  return weeks;
}

function getActivityLevel(scoreCount: number, typicalSession: number): 0 | 1 | 2 | 3 | 4 {
  if (scoreCount <= 0) return 0;
  if (scoreCount < typicalSession * 0.5) return 1;
  if (scoreCount < typicalSession) return 2;
  if (scoreCount < typicalSession * 2) return 3;
  return 4;
}

function getActivityCellStyle(day: ActivityDay, typicalSession: number) {
  const ratio = Math.min(1, day.scoreCount / Math.max(1, typicalSession * 2.4));
  const eased = Math.sqrt(ratio);
  const saturation = Math.round(58 + eased * 42);
  const lightness = Math.round(20 + eased * 55);
  const alpha = (0.62 + eased * 0.38).toFixed(2);
  const borderAlpha = (0.08 + eased * 0.22).toFixed(2);
  return {
    backgroundColor: `hsl(var(--theme-hue) calc(${saturation}% * var(--theme-sat)) ${lightness}% / ${alpha})`,
    borderColor: `hsl(var(--theme-hue) calc(100% * var(--theme-sat)) 82% / ${borderAlpha})`,
    boxShadow: "none",
  };
}

function groupActivityTimelineBySession(segments: ActivityTimelineSegment[]): ActivityTimelineSegment[][] {
  const groups = new Map<number, ActivityTimelineSegment[]>();
  for (const segment of segments) {
    groups.set(segment.sessionIndex, [...(groups.get(segment.sessionIndex) ?? []), segment]);
  }
  return [...groups.values()]
    .sort((a, b) => Date.parse(a[0].startAt) - Date.parse(b[0].startAt));
}

function getActivityPrimarySkill(skills: LivePlayerActivitySkillVector | null): LivePlayerActivityPrimarySkill {
  return skills?.primary ?? "unknown";
}

// Pattern ids come from the backend's dan estimator families; unknown ids get
// a derived label and a palette color so future families render unchanged.
const ACTIVITY_PATTERN_META: Record<string, { label: string; shortLabel: string; color: string }> = {
  stream: { label: "Stream", shortLabel: "S", color: "#8f6bd8" },
  jumpstream: { label: "Jumpstream", shortLabel: "JS", color: "#6f87d8" },
  handstream: { label: "Handstream", shortLabel: "HS", color: "#b06bc0" },
  jack: { label: "Jack", shortLabel: "J", color: "#c66f84" },
  chordjack: { label: "Chordjack", shortLabel: "CJ", color: "#c59a5c" },
  stamina: { label: "Stamina", shortLabel: "ST", color: "#ad6b5d" },
  tech: { label: "Tech", shortLabel: "T", color: "#83a86f" },
  ln: { label: "LN", shortLabel: "LN", color: "#57aeba" },
  lnGeneral: { label: "LN General", shortLabel: "LNG", color: "#63bf98" },
  lnRelease: { label: "LN Release", shortLabel: "LNR", color: "#58b7d9" },
  lnInverse: { label: "LN Inverse", shortLabel: "LNI", color: "#7fbed2" },
  lnTech: { label: "LN Tech", shortLabel: "LNT", color: "#9f78df" },
  unknown: { label: "Unknown", shortLabel: "", color: "#5f596b" },
};

const ACTIVITY_PATTERN_FALLBACK_COLORS = ["#8c7fb8", "#b88a7f", "#7fb89a", "#b8a87f", "#7f9ab8"];

function getActivityPatternMeta(patternId: string, keyCount: number | null): { label: string; shortLabel: string; color: string } {
  // The estimator's handstream family reads as brackets in 7K+ vocabulary;
  // the score is the same, only the label follows the keymode.
  if (patternId === "handstream" && keyCount != null && keyCount >= 7) {
    return { label: "Bracket", shortLabel: "B", color: ACTIVITY_PATTERN_META.handstream.color };
  }
  const meta = ACTIVITY_PATTERN_META[patternId];
  if (meta) return meta;
  let hash = 0;
  for (let index = 0; index < patternId.length; index++) hash = (hash * 31 + patternId.charCodeAt(index)) | 0;
  return {
    label: patternId.charAt(0).toUpperCase() + patternId.slice(1),
    shortLabel: patternId.slice(0, 2).toUpperCase(),
    color: ACTIVITY_PATTERN_FALLBACK_COLORS[Math.abs(hash) % ACTIVITY_PATTERN_FALLBACK_COLORS.length],
  };
}

function getActivityPatternEntries(patterns: LivePlayerActivityPatterns | null | undefined, keyCount: number | null) {
  return Object.entries(patterns ?? {})
    .map(([key, raw]) => {
      const meta = getActivityPatternMeta(key, keyCount);
      return { key, label: meta.label, shortLabel: meta.shortLabel, value: Math.round(clamp01(Number(raw)) * 100) };
    })
    .filter(({ value }) => value >= 5)
    .sort((left, right) => right.value - left.value);
}

function getActivitySkillColor(skill: LivePlayerActivityPrimarySkill): string {
  return getActivityPatternMeta(skill, null).color;
}

// Weights mirror the bar cells' flexGrow so run boundaries line up exactly
// with the segment boundaries above them.
function groupActivityKeymodeRuns(session: ActivityTimelineSegment[]): { key: string; keyCount: number | null; weight: number }[] {
  const runs: { key: string; keyCount: number | null; weight: number }[] = [];
  for (const segment of session) {
    const prev = runs[runs.length - 1];
    const weight = Math.max(1, segment.playCount);
    if (prev && prev.keyCount === segment.keyCount) {
      prev.weight += weight;
    } else {
      runs.push({ key: segment.key, keyCount: segment.keyCount, weight });
    }
  }
  return runs;
}

function getActivityTimelineSegmentColor(segment: ActivityTimelineSegment): string {
  return getActivitySkillColor(segment.primarySkill);
}

function getActivitySkillLabel(skill: LivePlayerActivityPrimarySkill, keyCount: number | null): string {
  if (skill === "mixed") return "Hybrid";
  return getActivityPatternMeta(skill, keyCount).label;
}

function getActivitySkillShortLabel(skill: LivePlayerActivityPrimarySkill, keyCount: number | null): string {
  if (skill === "mixed") return "Hyb";
  return getActivityPatternMeta(skill, keyCount).shortLabel;
}

function formatActivityKeyFlow(segments: ActivityTimelineSegment[]): string {
  const labels = [...new Set(segments
    .map((segment) => formatActivityKeyCount(segment.keyCount))
    .filter((label): label is string => label != null))];
  if (labels.length === 0) return "mixed keys";
  return labels.join(" / ");
}

function formatActivityFlowSegmentLabel(segment: ActivityTimelineSegment): string {
  const skill = segment.primarySkill === "unknown"
    ? null
    : getActivitySkillShortLabel(segment.primarySkill, segment.keyCount);
  return [skill, formatNumber(segment.playCount)].filter(Boolean).join(" ");
}

// Adjacent same-keymode same-skill segments read as one block; merging them
// frees enough width for the survivors' labels.
function mergeActivitySessionSegments(session: ActivityTimelineSegment[]): ActivityTimelineSegment[] {
  const merged: ActivityTimelineSegment[] = [];
  for (const segment of session) {
    const prev = merged[merged.length - 1];
    if (prev && prev.keyCount === segment.keyCount && prev.primarySkill === segment.primarySkill) {
      merged[merged.length - 1] = {
        ...prev,
        endAt: segment.endAt,
        playCount: prev.playCount + segment.playCount,
        patterns: mergeActivityPatterns(prev.patterns, prev.playCount, segment.patterns, segment.playCount),
      };
    } else {
      merged.push(segment);
    }
  }
  return merged;
}

function mergeActivityPatterns(
  left: LivePlayerActivityPatterns,
  leftPlays: number,
  right: LivePlayerActivityPatterns,
  rightPlays: number,
): LivePlayerActivityPatterns {
  const total = Math.max(1, leftPlays + rightPlays);
  const out: LivePlayerActivityPatterns = {};
  for (const key of new Set([...Object.keys(left ?? {}), ...Object.keys(right ?? {})])) {
    out[key] = ((Number(left?.[key]) || 0) * leftPlays + (Number(right?.[key]) || 0) * rightPlays) / total;
  }
  return out;
}

function getActivityFlowLegend(segments: ActivityTimelineSegment[]): { label: string; color: string; plays: number }[] {
  const entries = new Map<string, { label: string; color: string; plays: number; known: boolean }>();
  for (const segment of segments) {
    const known = segment.primarySkill !== "unknown";
    const label = known ? getActivitySkillLabel(segment.primarySkill, segment.keyCount) : "Unanalyzed";
    const entry = entries.get(label) ?? { label, color: getActivityTimelineSegmentColor(segment), plays: 0, known };
    entry.plays += segment.playCount;
    entries.set(label, entry);
  }
  const list = [...entries.values()]
    .sort((a, b) => Number(b.known) - Number(a.known) || b.plays - a.plays);
  // A legend that only says "Unanalyzed" decodes nothing.
  return list.some((entry) => entry.known) ? list : [];
}

function createDevActivityPatterns(skill: LivePlayerActivityPrimarySkill, keyCount: number | null): LivePlayerActivityPatterns {
  if (skill === "unknown") return {};
  const base: LivePlayerActivityPatterns = keyCount != null && keyCount >= 7
    ? { ln: 0.46, lnRelease: 0.34, handstream: 0.3, stream: 0.36, tech: 0.32 }
    : { stream: 0.42, jumpstream: 0.31, tech: 0.38, jack: 0.26, chordjack: 0.24, stamina: 0.45 };
  if (skill === "mixed") return { ...base, stream: 0.64, chordjack: 0.6, tech: 0.58 };
  return { ...base, [skill]: 0.88 };
}

function createDevActivityMap(
  index: number,
  title: string,
  artist: string,
  version: string,
  keyCount: number,
  plays: number,
  accuracy: number,
  pp: number,
  primary: LivePlayerActivityPrimarySkill | null,
): ActivityPlayedMap {
  return {
    key: `dev-map-${index}`,
    beatmapId: 4000000 + index,
    beatmapsetId: 1900000 + index,
    title,
    artist,
    version,
    coverUrl: null,
    plays,
    accuracy,
    pp,
    rank: "S",
    keyCount,
    skills: primary ? { primary, patterns: createDevActivityPatterns(primary, keyCount) } : null,
  };
}

// Dev-only fixture for previewing the day modal with a busy multi-keymode day;
// local setups usually run without osu! API jobs, so real days stay sparse.
// Covers: adjacent merge candidates, sub-threshold segments, unanalyzed
// segments, 7K bracket relabeling, hybrid, partial analysis, map overflow.
function createDevActivityDay(timezone: string): ActivityDay {
  const sessionSpecs: { keyCount: number | null; skill: LivePlayerActivityPrimarySkill; plays: number; minutes: number }[][] = [
    [
      { keyCount: 4, skill: "chordjack", plays: 5, minutes: 14 },
      { keyCount: 4, skill: "stream", plays: 1, minutes: 3 },
      { keyCount: 4, skill: "stream", plays: 3, minutes: 9 },
      { keyCount: 4, skill: "tech", plays: 2, minutes: 6 },
      { keyCount: 4, skill: "unknown", plays: 1, minutes: 3 },
      { keyCount: 4, skill: "jack", plays: 1, minutes: 2 },
      { keyCount: 4, skill: "chordjack", plays: 6, minutes: 16 },
      { keyCount: 4, skill: "mixed", plays: 4, minutes: 11 },
      { keyCount: 7, skill: "jumpstream", plays: 3, minutes: 8 },
    ],
    [
      { keyCount: 7, skill: "ln", plays: 6, minutes: 18 },
      { keyCount: 7, skill: "handstream", plays: 2, minutes: 7 },
      { keyCount: 7, skill: "unknown", plays: 1, minutes: 3 },
      { keyCount: 7, skill: "lnRelease", plays: 4, minutes: 12 },
      { keyCount: 7, skill: "mixed", plays: 5, minutes: 13 },
    ],
    [
      { keyCount: 4, skill: "stamina", plays: 7, minutes: 19 },
      { keyCount: 4, skill: "stream", plays: 2, minutes: 5 },
    ],
  ];
  const start = new Date();
  start.setHours(13, 40, 0, 0);
  let cursor = start.getTime();
  const timeline: ActivityTimelineSegment[] = [];
  sessionSpecs.forEach((session, sessionIndex) => {
    session.forEach((spec, segmentIndex) => {
      const startAt = new Date(cursor).toISOString();
      cursor += spec.minutes * 60_000;
      timeline.push({
        key: `dev:${sessionIndex}:${segmentIndex}`,
        sessionIndex,
        startAt,
        endAt: new Date(cursor).toISOString(),
        playCount: spec.plays,
        keyCount: spec.keyCount,
        primarySkill: spec.skill,
        patterns: createDevActivityPatterns(spec.skill, spec.keyCount),
      });
    });
    cursor += 75 * 60_000;
  });
  const scoreCount = timeline.reduce((sum, segment) => sum + segment.playCount, 0);
  const playsForKeyCount = (keyCount: number) => timeline
    .filter((segment) => segment.keyCount === keyCount)
    .reduce((sum, segment) => sum + segment.playCount, 0);
  const maps = [
    createDevActivityMap(1, "Quantum Surgery", "Camellia", "[4K] Lasersweep", 4, 6, 0.9641, 412, "chordjack"),
    createDevActivityMap(2, "Snow Crystals", "yuki.", "[4K] Hyper", 4, 5, 0.9893, 121, "stream"),
    createDevActivityMap(3, "Lights of Muse", "xi", "[7K] LN Master", 7, 4, 0.9712, 287, "ln"),
    createDevActivityMap(4, "Backbeat Maniac", "Eternal", "[4K] SHD", 4, 4, 0.9534, 198, "stamina"),
    createDevActivityMap(5, "Brain Power", "NOMA", "[4K] Another", 4, 3, 0.9477, 233, "mixed"),
    createDevActivityMap(6, "Future Dominators", "technoplanet", "[7K] 4 Dimensions", 7, 3, 0.9588, 305, "handstream"),
    createDevActivityMap(7, "Grand Thaw", "Aoi", "[7K] Release", 7, 3, 0.9821, 176, "lnRelease"),
    createDevActivityMap(8, "Pure Ruby", "DJ Sharpnel", "[4K] Lunatic", 4, 2, 0.9312, 264, "jack"),
    createDevActivityMap(9, "Cicadidae", "t+pazolite", "[4K] Extra", 4, 2, 0.9665, 209, "tech"),
    createDevActivityMap(10, "Unknown Signal", "Various Artists", "[4K] ???", 4, 1, 0.9402, 88, null),
  ];
  return {
    date: getZonedDateKey(start, timezone),
    scoreCount,
    passedCount: Math.round(scoreCount * 0.7),
    sessionCount: sessionSpecs.length,
    mapCount: maps.length + 4,
    level: 4,
    maps,
    skills: {
      patterns: { stream: 0.74, chordjack: 0.72, tech: 0.66, stamina: 0.62, jack: 0.48 },
      analyzedPlays: scoreCount - 2,
      totalPlays: scoreCount,
      keyModes: [
        {
          keyCount: 4,
          patterns: { stream: 0.86, chordjack: 0.72, tech: 0.71, stamina: 0.7, jack: 0.61 },
          analyzedPlays: playsForKeyCount(4) - 1,
          totalPlays: playsForKeyCount(4),
        },
        {
          keyCount: 7,
          patterns: { ln: 0.82, lnRelease: 0.66, handstream: 0.58, stream: 0.4 },
          analyzedPlays: playsForKeyCount(7) - 1,
          totalPlays: playsForKeyCount(7),
        },
      ],
    },
    timeline,
  };
}

function formatActivitySegmentTitle(segment: ActivityTimelineSegment, timeZone: string): string {
  const scores = getActivityPatternEntries(segment.patterns, segment.keyCount)
    .slice(0, 4)
    .map(({ shortLabel, value }) => `${shortLabel} ${value}%`)
    .join(" / ");
  return [
    `${formatActivityTime(segment.startAt, timeZone)} - ${formatActivityTime(segment.endAt, timeZone)}`,
    `${formatNumber(segment.playCount)} ${segment.playCount === 1 ? "play" : "plays"}`,
    formatActivityKeyCount(segment.keyCount),
    getActivitySkillLabel(segment.primarySkill, segment.keyCount),
    scores,
  ].filter(Boolean).join(" • ");
}

function formatActivityKeyCount(keyCount: number | null): string | null {
  if (keyCount == null || !Number.isFinite(keyCount) || keyCount <= 0) return null;
  return `${Math.round(keyCount)}K`;
}

// Safety net: with player-timezone bucketing a session always falls on its
// heatmap date, but stale data from an older backend can still cross over;
// label those sessions with their date so the order stays legible.
function formatActivitySessionDate(startAt: string, dayKey: string, timeZone: string): string | null {
  const date = new Date(startAt);
  if (!Number.isFinite(date.getTime())) return null;
  if (getZonedDateKey(date, timeZone) === dayKey) return null;
  try {
    return date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone });
  } catch {
    return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }
}

// en-CA formats as YYYY-MM-DD, matching the backend's day keys.
function getZonedDateKey(date: Date, timeZone: string): string {
  try {
    return date.toLocaleDateString("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  } catch {
    return toDateKey(date);
  }
}

function formatActivityTime(value: string, timeZone: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  try {
    return date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone });
  } catch {
    return date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  }
}

// Shown only when the viewer's clock differs from the player's timezone, so
// the session times don't read as broken to foreign visitors.
function getActivityTimezoneHint(timeZone: string, referenceIso: string | undefined): string | null {
  const reference = referenceIso ? new Date(referenceIso) : new Date();
  if (!Number.isFinite(reference.getTime())) return null;
  try {
    const zoned = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "shortOffset" })
      .formatToParts(reference)
      .find((part) => part.type === "timeZoneName")?.value ?? null;
    const local = new Intl.DateTimeFormat("en-US", { timeZoneName: "shortOffset" })
      .formatToParts(reference)
      .find((part) => part.type === "timeZoneName")?.value ?? null;
    if (!zoned || zoned === local) return null;
    return zoned;
  } catch {
    return null;
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addLocalDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function toDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseLocalDateKey(date: string): Date {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(year, (month || 1) - 1, day || 1);
}

function formatFullActivityDate(date: string): string {
  return parseLocalDateKey(date).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

function formatActivityMonth(date: string): string {
  return parseLocalDateKey(date).toLocaleDateString("en-US", {
    month: "short",
  });
}

function PlayerAboutCard({ html, onEdit }: { html: string; onEdit: () => void }) {
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
    <div className="relative bg-osu-b4 rounded-xl border border-osu-b3/20 overflow-hidden">
      <button
        type="button"
        onClick={onEdit}
        title="Open in the BBCode editor"
        aria-label="Open in the BBCode editor"
        className="absolute top-2.5 right-2.5 z-10 w-8 h-8 flex items-center justify-center rounded-full bg-osu-b3/80 text-osu-l2 border border-osu-b3/40 hover:bg-osu-b2 hover:text-osu-c1 transition-colors cursor-pointer"
      >
        <Pencil size={14} />
      </button>
      <div
        ref={contentRef}
        className="bbcode-content px-4 py-3 text-sm text-osu-l2 max-h-[520px] overflow-y-auto"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}

function BestScoresControlBar({
  availableKeyModes,
  keyFilter,
  onChangeKeyFilter,
  mods,
  modFilter,
  onCycleMod,
  onReverseCycleMod,
  onClearMods,
  sort,
  ageSort,
  onChangeSort,
}: {
  availableKeyModes: string[];
  keyFilter: KeyFilter;
  onChangeKeyFilter: (keyFilter: KeyFilter) => void;
  mods: string[];
  modFilter: ModFilterState;
  onCycleMod: (mod: string) => void;
  onReverseCycleMod: (mod: string) => void;
  onClearMods: () => void;
  sort: BestSort;
  ageSort: BestAgeSort;
  onChangeSort: (sort: BestSort) => void;
}) {
  const hasActiveFilter = Object.keys(modFilter).length > 0;

  return (
    <div className="mt-3 flex flex-col gap-2 lg:flex-row lg:items-start lg:justify-between">
      <div className="order-2 flex items-center gap-2 flex-wrap min-w-0 lg:order-1">
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
      <div className="order-1 flex w-full flex-nowrap items-center justify-between gap-2 overflow-x-auto scrollbar-hide lg:order-2 lg:w-auto lg:flex-col lg:items-end lg:justify-start lg:overflow-visible">
        {availableKeyModes.length > 1 && (
          <div className="lg:hidden">
            <KeyModeControl
              availableKeyModes={availableKeyModes}
              keyFilter={keyFilter}
              onChangeKeyFilter={onChangeKeyFilter}
            />
          </div>
        )}
        <BestSortControl sort={sort} ageSort={ageSort} onChangeSort={onChangeSort} />
      </div>
    </div>
  );
}

function BestSortControl({
  sort,
  ageSort,
  onChangeSort,
}: {
  sort: BestSort;
  ageSort: BestAgeSort;
  onChangeSort: (sort: BestSort) => void;
}) {
  const ageActive = sort === "newest" || sort === "oldest";
  const ageArrow = ageSort === "oldest" ? "↑" : "↓";
  const nextAgeSort: BestAgeSort = ageActive
    ? (ageSort === "newest" ? "oldest" : "newest")
    : ageSort;

  return (
    <div className="flex items-center gap-1 shrink-0">
      <span className="hidden text-[9px] uppercase tracking-wider text-osu-f1 font-semibold sm:inline">Sort</span>
      <div className="flex items-center gap-0.5 rounded-lg bg-osu-b4/60 border border-osu-b3/20 p-0.5 sm:gap-1 sm:p-1">
        <button
          type="button"
          onClick={() => onChangeSort("pp")}
          className={`px-2 py-1.5 rounded-md text-[10px] font-semibold transition-colors cursor-pointer sm:px-3 sm:text-[11px] ${sort === "pp"
              ? "bg-osu-pink/15 text-osu-pink-light"
              : "text-osu-f1 hover:text-osu-l2 hover:bg-osu-b3/50"
            }`}
        >
          <span className="sm:hidden">PP</span>
          <span className="hidden sm:inline">Top PP</span>
        </button>
        <button
          type="button"
          onClick={() => onChangeSort(nextAgeSort)}
          title={ageSort === "oldest" ? "Oldest first" : "Newest first"}
          className={`px-2 py-1.5 rounded-md text-[10px] font-semibold transition-colors cursor-pointer sm:px-3 sm:text-[11px] ${ageActive
              ? "bg-osu-pink/15 text-osu-pink-light"
              : "text-osu-f1 hover:text-osu-l2 hover:bg-osu-b3/50"
            }`}
        >
          Age {ageArrow}
        </button>
      </div>
    </div>
  );
}

function KeyModeControl({
  availableKeyModes,
  keyFilter,
  onChangeKeyFilter,
}: {
  availableKeyModes: string[];
  keyFilter: KeyFilter;
  onChangeKeyFilter: (keyFilter: KeyFilter) => void;
}) {
  return (
    <div className="inline-flex shrink-0 items-center gap-0.5 rounded-lg bg-osu-b4/60 border border-osu-b3/20 p-0.5 sm:gap-1 sm:p-1">
      {[["all", "All"] as const, ...availableKeyModes.map((k) => [k, k.toUpperCase()] as const)].map(([value, label]) => (
        <button
          key={value}
          onClick={() => onChangeKeyFilter(value)}
          className={`px-2 py-1.5 rounded-md text-[10px] font-semibold transition-colors cursor-pointer sm:px-3 sm:text-[11px] ${keyFilter === value
              ? "bg-osu-pink/15 text-osu-pink-light"
              : "text-osu-f1 hover:text-osu-l2 hover:bg-osu-b3/50"
            }`}
        >
          {label}
        </button>
      ))}
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

const PP_DISTRIBUTION_COLORS = [
  "var(--color-osu-purple-light)",
  "var(--color-osu-pink-light)",
  "var(--color-osu-orange)",
  "var(--color-osu-yellow)",
  "var(--color-osu-blue)",
  "var(--color-osu-green-light)",
];

function getPpDistributionColor(index: number, isBelowBucket: boolean): string {
  if (isBelowBucket) return "var(--color-osu-f1)";
  return PP_DISTRIBUTION_COLORS[Math.min(index, PP_DISTRIBUTION_COLORS.length - 1)];
}

function formatPpDistributionLabel(entry: UserProfileInsights["ppDistribution"][number]): string {
  if (entry.min == null) return `below ${(entry.max ?? 399) + 1}`;
  if (entry.max == null) return `${entry.min}+`;
  return `${entry.min}-${entry.max}`;
}

function formatPpCumulativeDistributionLabel(threshold: number): string {
  return `${threshold}+`;
}

function formatPpDistributionPercent(count: number, total: number): string {
  if (total <= 0) return "0%";
  return `${((count / total) * 100).toLocaleString("en-US", {
    maximumFractionDigits: 1,
    minimumFractionDigits: 0,
  })}%`;
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

  const href = snapshot.scoreUrl ?? snapshot.beatmapUrl;

  return (
    <a
      href={href}
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
  const keymodeLabel = getBeatmapKeymodeLabel(score.beatmap);
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
          {keymodeLabel && (
            <span className="px-1 py-0.5 rounded text-[8px] font-bold bg-osu-b3/50 text-osu-yellow flex-shrink-0">
              {keymodeLabel}
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
