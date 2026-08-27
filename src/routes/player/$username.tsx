import { Link, createFileRoute, useLocation, useNavigate } from "@tanstack/react-router";
import { Suspense, lazy, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Check, ExternalLink, Pencil, RefreshCw, X } from "lucide-react";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { msg } from "@lingui/core/macro";
import type { I18n, MessageDescriptor } from "@lingui/core";
import {
  getUser,
  getUserScoresBestWindow,
} from "../../lib/osu";
import {
  fetchLivePlayerCachedProfileSnapshot,
  fetchLivePlayerActivityDirect,
  fetchLivePlayerActivityDayDirect,
  fetchLivePlayerAboutDirect,
  fetchLivePlayerKeymodePpDirect,
  fetchLivePlayerKeymodePpKeysDirect,
  fetchLivePlayerProfileSnapshotDirect,
  fetchLivePlayerRecentScoresDirect,
  fetchLivePlayerSkillsDirect,
  isLiveBackendConfigured,
  type LivePlayerSkills,
  type LivePlayerActivityPatterns,
  type LivePlayerActivityPrimarySkill,
  type LivePlayerActivitySnapshot,
  type LivePlayerActivitySkillReadout,
  type LivePlayerActivitySkillVector,
  type LivePlayerActivityTimelineSegment,
  type LiveKeymodePpPlay,
  type LivePlayerKeymodePpTail,
  type LivePlayerProfileSnapshot,
} from "../../lib/live-backend";
import {
  formatNumber,
  formatAccuracy,
  formatTimeAgo,
  formatTimeAgoTooltip,
  formatDetailedTimeAgo,
  formatDate,
  formatPP,
} from "../../lib/format";
import { useViewerTimeZone } from "../../lib/use-viewer-time-zone";
import { useHasHydrated } from "../../store";
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
import { useAuth } from "../../lib/auth-context";
import { addSelfToRoster } from "../../lib/roster-self-track";
import { showTrackingStartedToast } from "../../components/me/TrackingToasts";
import { GradeImg } from "../../components/ui/GradeImg";
import { OsuLogo } from "../../components/ui/OsuLogo";
import { CountryFlag } from "../../components/ui/CountryFlag";
import { StarRatingBadge } from "../../components/ui/StarRating";
import { getManiaJudgementStats } from "../../components/ui/ManiaJudgementStats";
import { ModBadge } from "../../components/ui/ModBadge";
import { LazerBadge } from "../../components/ui/LazerBadge";
import { DanBadge } from "../../components/ui/DanBadge";
import { ScoreRowSkeleton, Skeleton } from "../../components/ui/LoadingSkeleton";
import { UsernameText } from "../../components/ui/UsernameText";
import { ManiaCard3DPanel as ManiaCardPanel } from "../../components/player/maniacard3d/ManiaCard3DPanel";
import { computeManiaSkills, type ManiaCardTier, type ManiaSkills } from "../../lib/maniacard";
import { SkillBreakdownBody, SkillModePanel } from "../../components/player/SkillBreakdown";
import { qualifyingSkillModes, skillRatingAccent, type SkillAxisEntry } from "../../lib/skill-axes";
import { SkillPlaysModal } from "../../components/player/SkillPlaysModal";
import { DanEvidenceModal } from "../../components/player/DanEvidenceModal";
import type { InsightScoreSnapshot, OsuCovers, OsuScore, OsuUser, UserProfileInsights } from "../../lib/types";
import { buildPpCumulativeDistribution, buildPpDistribution, calculateUserProfileInsights, KEY_PP_LIST_LIMIT } from "../../lib/profile-insights";
import { buildTrackedPlayScore } from "../../lib/tracked-play-score";
import {
  playedWithinOnlineWindow,
  readPlayerRecentPlay,
  readPlayerShell,
  stripUntrackedProfilePresence,
} from "../../lib/player-shell-cache";
import { pageSeo, playerOgImagePath } from "../../lib/seo";
import { getRankTierClass } from "../../lib/rankings";
import { displayCountryName, isSupportedCountryCode } from "../../lib/country";
import { useLocale } from "../../lib/locale-context";
import { preservePlayerCountryFlagState } from "../../lib/player-profile-navigation";

// The BBCode editor (toolbar + parser + preview) only loads when someone
// actually opens it; the about tab itself stays light.
const BBCodeEditorLazy = lazy(() => import("../../components/player/bbcode/BBCodeEditor"));

const userRequestCache = new Map<string, Promise<OsuUser>>();
const userRecentRequestCache = new Map<number, Promise<OsuScore[]>>();
const userBestWindowRequestCache = new Map<number, Promise<OsuScore[]>>();
const userDataCache = new Map<string, { data: OsuUser; expiresAt: number }>();
const userRecentDataCache = new Map<number, { data: OsuScore[]; expiresAt: number }>();
const userBestWindowDataCache = new Map<number, { data: OsuScore[]; expiresAt: number }>();
type PlayerSnapshotData = {
  user: OsuUser;
  bestScores: OsuScore[];
  keymodeKeyCounts?: number[];
  fetchedAt: string;
  userFetchedAt: string;
  isStale: boolean;
};
const playerSnapshotDataCache = new Map<string, { data: PlayerSnapshotData; expiresAt: number }>();
const playerSnapshotRequestCache = new Map<string, Promise<PlayerSnapshotData | null>>();
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
// Mirrors PROFILE_SECTION_TTL_MS in the live backend. The response's fetchedAt
// anchors this cooldown, so a cached response only disables the remaining time.
const PLAYER_RECENT_OSU_REFRESH_COOLDOWN_MS = 2 * 60_000;
const PROFILE_SNAPSHOT_BEST_GRACE_MS = 450;
const PROFILE_SNAPSHOT_REFRESH_DEFER_MS = 2500;
const PROFILE_USER_METADATA_STALE_MS = 10 * 60_000;
// A snapshot whose user metadata the backend has not refreshed inside
// PROFILE_USER_METADATA_STALE_MS used to cache for a single second, on the
// assumption the retry ladder below would pick up the queued refresh and
// re-cache at the full TTL. It does that about 59% of the time; the rest of the
// time the entry expired before the visitor could come back, so re-entering a
// profile paid for another ~690KB snapshot and another skeleton. Nearly every
// stored profile sits past the stale mark (13,335 of 13,373 on prod), so that
// was the normal path, not the exception. Keep the shortened TTL -- a stale
// profile really should be re-checked sooner -- but make it long enough to
// survive a back-and-forth, and let the stale-while-revalidate window below
// cover the gap beyond it.
const PROFILE_USER_METADATA_STALE_CACHE_TTL = 60_000;
// Past its TTL a cached snapshot is still worth painting immediately while a
// fresh one loads underneath. Re-entering a profile is the common case and the
// visitor already saw this data seconds ago; showing it again beats showing a
// skeleton. Beyond this window the data is old enough to be worth waiting for.
const PLAYER_SNAPSHOT_STALE_WHILE_REVALIDATE_MS = 30 * 60_000;
const PROFILE_USER_METADATA_RETRY_DELAYS_MS = [1200, 3500, 8000, 15000] as const;
// Each ladder rung refetches the whole snapshot, and the ladder re-arms on every
// mount. Without this, bouncing in and out of a profile multiplies the ladder by
// the number of visits; one run per profile per cooldown is plenty given the
// median refresh lands at ~22s.
const PROFILE_USER_METADATA_RETRY_COOLDOWN_MS = 30_000;
const playerSnapshotMetadataRetryStartedAt = new Map<string, number>();
// With SSR pinned next to the backend (fra1 <-> Nuremberg, ~5ms RTT) the happy
// path is ~50ms; this budget exists to absorb backend event-loop stalls, which
// run ~0.5-1.5s. Waiting one out beats serving a skeleton: a miss costs the
// visitor a multi-second client-side refetch instead.
const PROFILE_CACHED_SNAPSHOT_LOADER_TIMEOUT_MS = 1_200;
// The SSR document only needs enough scores to paint the initial list; the
// profile-wide insight projection is calculated separately before this slice.
// The deferred post-mount refresh streams the full 200-score window straight
// from the live backend. Embedding all 200 made the player document the biggest
// origin-transfer line on Vercel.
const PROFILE_LOADER_BEST_SCORES_LIMIT = 50;
const INITIAL_SCORE_BATCH_SIZE = 5;
const SHOW_MORE_BATCH_SIZE = 50;
const BEST_SCORES_WINDOW_SIZE = 200;
const RECENT_PRIORITY_DEFER_MS = 1200;
const TUNG_TUNG_SAHUR_AUDIO_SRC = "/audio/tung-tung-sahur-keycap.mp3";
const TUNG_TUNG_SAHUR_GLOW_COLORS = ["#38d9ff", "#ff3f57", "#8bff3f", "#b45cff", "#ffd53d", "#ff7a2f"];
const TUNG_TUNG_SAHUR_BASE_REST = { y: 0, scaleY: 1 };
const TUNG_TUNG_SAHUR_TOP_REST = { x: -3.25, y: 4, scaleY: 1, filter: "brightness(1)" };
const TUNG_TUNG_SAHUR_ACTUATION_MS = 49;
export type PlayerTab = "best" | "recent" | "card" | "about" | "activity" | "skills";
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

const PLAYER_TABS: PlayerTab[] = ["best", "recent", "skills", "about", "card", "activity"];
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
  if (tab === "skills") return "Skills";
  return "About";
}

function getPlayerTabLabelMsg(tab: PlayerTab): MessageDescriptor {
  if (tab === "best") return msg`Best Performance`;
  if (tab === "recent") return msg`Recent Plays`;
  if (tab === "card") return msg`Maniacard`;
  if (tab === "activity") return msg`Activity`;
  if (tab === "skills") return msg`Skills`;
  return msg`About`;
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
  if (tabSlug === "skills") return "skills";
  if (tabSlug === "activity") return normalizePlayerTab("activity");
  return "best";
}

function readLegacyShowCountryFlag(searchStr: string): boolean {
  const value = new URLSearchParams(searchStr).get("showCountry");
  return value === "true" || value === "1";
}

function hasLegacyShowCountryParam(searchStr: string): boolean {
  return new URLSearchParams(searchStr).has("showCountry");
}

export type PlayerLoaderData = {
  cachedSnapshot: LivePlayerProfileSnapshot | null;
  cachedInsights: UserProfileInsights | null;
  cachedBestFilters: PlayerBestFilterMetadata | null;
  cachedManiaCardSkills: ManiaSkills | null;
};

type PlayerBestFilterMetadata = {
  keyModes: string[];
  mods: string[];
};

const EMPTY_PLAYER_BEST_FILTERS: PlayerBestFilterMetadata = {
  keyModes: [],
  mods: [],
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
      note_bpm: score.beatmap.note_bpm,
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
    bestScores: snapshot.bestScores.slice(0, PROFILE_LOADER_BEST_SCORES_LIMIT).map(slimLoaderScore),
  };
}

// Keep the SSR score payload capped without changing full-window UI: insights,
// filter options, and Maniacard skills are tiny projections calculated before
// trimming the scores used to paint the initial list.
export function buildPlayerLoaderData(snapshot: LivePlayerProfileSnapshot | null): PlayerLoaderData {
  const bestScores = snapshot ? dedupeScores(snapshot.bestScores) : [];
  return {
    cachedSnapshot: snapshot ? slimLoaderSnapshot({ ...snapshot, bestScores }) : null,
    cachedInsights: bestScores.length
      ? calculateUserProfileInsights(bestScores)
      : null,
    cachedBestFilters: bestScores.length
      ? buildPlayerBestFilterMetadata(bestScores)
      : null,
    cachedManiaCardSkills: bestScores.length
      ? computeManiaSkills(bestScores, { globalPp: snapshot?.user.statistics?.pp })
      : null,
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
  // SSR only: on client navigations the page's own deferred snapshot fetch
  // goes straight to the live backend, so running the loader would round-trip
  // the same payload through a server function for nothing.
  if (typeof document !== "undefined") return buildPlayerLoaderData(null);

  let cachedSnapshot: LivePlayerProfileSnapshot | null = null;
  try {
    cachedSnapshot = await withProfileLoaderBudget(
      fetchCachedSnapshotWithRetry(username),
      PROFILE_CACHED_SNAPSHOT_LOADER_TIMEOUT_MS,
    );
  } catch {
    cachedSnapshot = null;
  }

  return buildPlayerLoaderData(cachedSnapshot);
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
type BestPpSort = "pp-desc" | "pp-asc";
type BestAgeSort = "newest" | "oldest";
type BestSort = BestPpSort | BestAgeSort;
type PpDistributionMode = "bands" | "cumulative";
const PP_DISTRIBUTION_MODE_STORAGE_KEY = "mania-hub-pp-distribution-mode-v1";

function isPpDistributionMode(value: unknown): value is PpDistributionMode {
  return value === "bands" || value === "cumulative";
}

function readPpDistributionModePreference(): PpDistributionMode {
  if (typeof window === "undefined") return "bands";

  try {
    const stored = window.localStorage.getItem(PP_DISTRIBUTION_MODE_STORAGE_KEY);
    return isPpDistributionMode(stored) ? stored : "bands";
  } catch {
    return "bands";
  }
}

function writePpDistributionModePreference(mode: PpDistributionMode): void {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.setItem(PP_DISTRIBUTION_MODE_STORAGE_KEY, mode);
  } catch {
    // Preference storage is best-effort; the modal still works normally.
  }
}

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

/* A keymode list is the plays behind that keymode's pp, and osu! grows its
   keymode statistics from natively-mania maps only, which is what the Key
   Split modal already tells the reader it leaves out. So a convert is a play
   under "All", where osu! does rank it, and not a row in one keymode's list:
   listing it there would put a play on screen that the total beside it never
   counted. Recent keeps the plain filter; nothing there is a total. */
export function matchesBestKeyFilter(score: OsuScore, keyFilter: KeyFilter): boolean {
  if (keyFilter === "all") return true;
  return !score.beatmap?.convert && matchesKeyFilter(score, keyFilter);
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

/** A Best Performance row: an osu! window score, or a play only this site's
    tracking has. Both are real plays; only their provenance differs. */
export type BestListRow =
  | { kind: "score"; score: OsuScore }
  | { kind: "tracked"; play: LiveKeymodePpPlay };

function bestListRowKey(row: BestListRow): string {
  return row.kind === "score" ? getScoreIdentity(row.score) : `tracked:${row.play.beatmapId}`;
}

function bestListRowPp(row: BestListRow): number | null {
  return row.kind === "score" ? getSortablePp(row.score) : row.play.pp;
}

function bestListRowTimeMs(row: BestListRow): number {
  if (row.kind === "score") return getScoreTimeMs(row.score);
  const ms = row.play.playedAt ? new Date(row.play.playedAt).getTime() : 0;
  return Number.isFinite(ms) ? ms : 0;
}

export function sortBestListRows(rows: BestListRow[], sort: BestSort): BestListRow[] {
  const copy = [...rows];
  if (sort === "pp-desc" || sort === "pp-asc") {
    copy.sort((a, b) => {
      const aPp = bestListRowPp(a);
      const bPp = bestListRowPp(b);
      if (aPp == null && bPp == null) return 0;
      if (aPp == null) return 1;
      if (bPp == null) return -1;
      return sort === "pp-desc" ? bPp - aPp : aPp - bPp;
    });
    return copy;
  }

  copy.sort((a, b) => {
    const diff = bestListRowTimeMs(b) - bestListRowTimeMs(a);
    return sort === "newest" ? diff : -diff;
  });
  return copy;
}

/** The mod filter over either kind of row, so a merged keymode list can be
    ranked and cut once and filtered afterwards. */
export function bestListRowMatchesModFilter(row: BestListRow, modFilter: ModFilterState): boolean {
  return row.kind === "score"
    ? matchesModFilter(row.score, modFilter)
    : matchesModAcronymFilter(row.play.mods, modFilter);
}

/** The mod filter, against the acronyms a tracked play carries instead of a
    score's mod objects. Same rules, so both kinds of row filter alike. */
export function matchesModAcronymFilter(acronyms: string[], modFilter: ModFilterState): boolean {
  const entries = Object.entries(modFilter);
  if (entries.length === 0) return true;

  const mods = new Set(acronyms);
  const hasNoMods = mods.size === 0;
  for (const [key, mode] of entries) {
    let present: boolean;
    if (key === NO_MOD_KEY) {
      present = hasNoMods;
    } else {
      const group = getModFilterGroup(key);
      present = group ? group.some((m) => mods.has(m)) : mods.has(key);
    }
    if (mode === "include" && !present) return false;
    if (mode === "exclude" && present) return false;
  }
  return true;
}

function getSortablePp(score: OsuScore): number | null {
  return typeof score.pp === "number" && Number.isFinite(score.pp) ? score.pp : null;
}

function sortBestScores(scores: OsuScore[], sort: BestSort): OsuScore[] {
  const copy = [...scores];
  if (sort === "pp-desc" || sort === "pp-asc") {
    copy.sort((a, b) => {
      const aPp = getSortablePp(a);
      const bPp = getSortablePp(b);
      if (aPp == null && bPp == null) return 0;
      if (aPp == null) return 1;
      if (bPp == null) return -1;
      return sort === "pp-desc" ? bPp - aPp : aPp - bPp;
    });
    return copy;
  }

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

function buildPlayerBestFilterMetadata(scores: OsuScore[]): PlayerBestFilterMetadata {
  return {
    keyModes: getAvailableKeyModes(scores),
    mods: getRelevantMods(scores),
  };
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

function sortRecentScores(scores: OsuScore[]): OsuScore[] {
  return [...scores].sort((a, b) => getScoreTimeMs(b) - getScoreTimeMs(a));
}

function mergeRecentScores(current: OsuScore[], fetched: OsuScore[]): OsuScore[] {
  return sortRecentScores(dedupeScores([...fetched, ...current]));
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

function profileSnapshotUserMetadataIsStale(snapshot: Pick<PlayerSnapshotData, "userFetchedAt">): boolean {
  const fetchedAt = Date.parse(snapshot.userFetchedAt);
  return !Number.isFinite(fetchedAt) || Date.now() - fetchedAt >= PROFILE_USER_METADATA_STALE_MS;
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
      const profileUser = stripUntrackedProfilePresence(user);
      userDataCache.set(cacheKey, {
        data: profileUser,
        expiresAt: Date.now() + USER_CLIENT_CACHE_TTL,
      });
      return profileUser;
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

export function resetPlayerSnapshotCachesForTests(): void {
  playerSnapshotDataCache.clear();
  playerSnapshotRequestCache.clear();
  playerSnapshotMetadataRetryStartedAt.clear();
  userDataCache.clear();
  userBestWindowDataCache.clear();
}

export function loadPlayerSnapshotCached(
  username: string,
  options: {
    bypassDataCache?: boolean;
    // Invoked when a stale-but-usable entry was served from cache and the
    // refresh behind it landed, so the page can swap in the newer data.
    onRevalidated?: (data: PlayerSnapshotData) => void;
  } = {},
): Promise<PlayerSnapshotData | null> {
  const cacheKey = username.trim().toLowerCase();
  const now = Date.now();
  const cachedData = playerSnapshotDataCache.get(cacheKey);
  if (!options.bypassDataCache && cachedData) {
    if (cachedData.expiresAt > now) return Promise.resolve(cachedData.data);
    if (now - cachedData.expiresAt <= PLAYER_SNAPSHOT_STALE_WHILE_REVALIDATE_MS) {
      const { onRevalidated } = options;
      void fetchPlayerSnapshot(cacheKey, username).then((fresh) => {
        if (fresh && onRevalidated) onRevalidated(fresh);
      });
      return Promise.resolve(cachedData.data);
    }
    // Too old to paint. Drop it so a failed refetch cannot resurrect it.
    playerSnapshotDataCache.delete(cacheKey);
  }
  return fetchPlayerSnapshot(cacheKey, username);
}

function fetchPlayerSnapshot(cacheKey: string, username: string): Promise<PlayerSnapshotData | null> {
  const cached = playerSnapshotRequestCache.get(cacheKey);
  if (cached) return cached;

  const request = fetchLivePlayerProfileSnapshotDirect(username)
    .then((snapshot) => {
      if (!snapshot) return null;
      const data = {
        user: snapshot.user,
        bestScores: dedupeScores(snapshot.bestScores),
        fetchedAt: snapshot.fetchedAt,
        userFetchedAt: snapshot.userFetchedAt,
        isStale: snapshot.isStale,
      };
      const userMetadataStale = profileSnapshotUserMetadataIsStale(data);
      const cacheTtl = userMetadataStale ? PROFILE_USER_METADATA_STALE_CACHE_TTL : PLAYER_SNAPSHOT_CLIENT_CACHE_TTL;
      const userCacheTtl = userMetadataStale ? PROFILE_USER_METADATA_STALE_CACHE_TTL : USER_CLIENT_CACHE_TTL;
      playerSnapshotDataCache.set(cacheKey, {
        data,
        expiresAt: Date.now() + cacheTtl,
      });
      userDataCache.set(cacheKey, {
        data: data.user,
        expiresAt: Date.now() + userCacheTtl,
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
      const dedupedScores = sortRecentScores(dedupeScores(scores));
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
  const legacyShowCountryFlag = readLegacyShowCountryFlag(location.searchStr);
  const hasLegacyShowCountry = hasLegacyShowCountryParam(location.searchStr);

  useEffect(() => {
    if (!hasLegacyShowCountry || typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    params.delete("showCountry");
    const nextSearch = params.toString();
    const nextUrl = `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ""}${window.location.hash}`;
    window.history.replaceState(
      {
        ...window.history.state,
        ...(legacyShowCountryFlag ? { showPlayerCountryFlag: true } : {}),
      },
      "",
      nextUrl,
    );
  }, [hasLegacyShowCountry, legacyShowCountryFlag]);

  return (
    <PlayerProfilePage
      username={username}
      loaderData={loaderData}
      initialTab={getPlayerTabFromPathname(location.pathname)}
      showCountryFlag={location.state.showPlayerCountryFlag === true || legacyShowCountryFlag}
    />
  );
}

// `?cardTier=goat` renders the card in an honorary tier the cardPower ladder
// can never reach, so the two candidate designs can be reviewed on a real
// profile. Read off the raw location so the route keeps its search schema.
const CARD_TIER_PREVIEWS = new Set<ManiaCardTier>(["goat"]);

function useCardTierPreview(): ManiaCardTier | undefined {
  const location = useLocation();
  const requested = (location.search as Record<string, unknown> | undefined)?.cardTier;
  if (typeof requested !== "string") return undefined;
  return CARD_TIER_PREVIEWS.has(requested as ManiaCardTier) ? (requested as ManiaCardTier) : undefined;
}

export function PlayerProfilePage({
  username,
  loaderData,
  initialTab,
  showCountryFlag = false,
}: {
  username: string;
  loaderData: PlayerLoaderData;
  initialTab: PlayerTab;
  showCountryFlag?: boolean;
}) {
  const navigate = useNavigate();
  const hasHydrated = useHasHydrated();
  const cardTierPreview = useCardTierPreview();
  const loaderSnapshot = loaderData?.cachedSnapshot ?? null;
  const loaderBestScores = useMemo(
    () => loaderSnapshot ? dedupeScores(loaderSnapshot.bestScores) : [],
    [loaderSnapshot],
  );
  // Never infer profile-wide insights from loaderBestScores: SSR deliberately
  // caps that list at 50, while these cards promise to describe the full
  // top-play window.
  const loaderProfileInsights = loaderData?.cachedInsights ?? null;
  const loaderBestFilters = loaderData?.cachedBestFilters ?? EMPTY_PLAYER_BEST_FILTERS;
  const loaderManiaCardSkills = loaderData?.cachedManiaCardSkills ?? null;
  const [user, setUser] = useState<OsuUser | null>(() => loaderSnapshot?.user ?? null);
  const [best, setBest] = useState<OsuScore[]>(() => loaderBestScores);
  const [bestFilters, setBestFilters] = useState<PlayerBestFilterMetadata>(() => loaderBestFilters);
  const [maniaCardSkills, setManiaCardSkills] = useState<ManiaSkills | null>(() => loaderManiaCardSkills);
  const [recent, setRecent] = useState<OsuScore[]>([]);
  const [aboutHtml, setAboutHtml] = useState<string | null>(null);
  const [aboutRaw, setAboutRaw] = useState<string | null>(null);
  const [aboutEditing, setAboutEditing] = useState(false);
  const [profileInsights, setProfileInsights] = useState<UserProfileInsights | null>(() => loaderProfileInsights);
  const [loadingUser, setLoadingUser] = useState(() => !loaderSnapshot?.user);
  // The player shell seeded from a ranking row carries no rank history or peak
  // rank, so the hero card waits for the snapshot rather than reflowing.
  const [loadingRankHistory, setLoadingRankHistory] = useState(() => !loaderSnapshot?.user);
  const [loadingRecent, setLoadingRecent] = useState(true);
  const [loadingOsuRecent, setLoadingOsuRecent] = useState(false);
  const [loadingAbout, setLoadingAbout] = useState(false);
  const [loadingInsights, setLoadingInsights] = useState(() => loaderProfileInsights === null);
  const [userError, setUserError] = useState<string | null>(null);
  const [bestError, setBestError] = useState<string | null>(null);
  const [recentError, setRecentError] = useState<string | null>(null);
  const [recentOsuError, setRecentOsuError] = useState<string | null>(null);
  const [recentOsuLoaded, setRecentOsuLoaded] = useState(false);
  const [recentOsuFetchedAt, setRecentOsuFetchedAt] = useState<string | null>(null);
  const [aboutError, setAboutError] = useState<string | null>(null);
  const [insightsError, setInsightsError] = useState<string | null>(null);
  const [tabState, setTab] = useState<PlayerTab>(() => normalizePlayerTab(initialTab));
  const auth = useAuth();
  const { t, i18n } = useLingui();
  const locale = useLocale();
  const tab = tabState;
  const playerTabs = PLAYER_TABS;
  const [keyFilter, setKeyFilter] = useState<KeyFilter>("all");
  const [bestModFilter, setBestModFilter] = useState<ModFilterState>({});
  const [bestSort, setBestSort] = useState<BestSort>("pp-desc");
  const [bestPpSort, setBestPpSort] = useState<BestPpSort>("pp-desc");
  const [bestAgeSort, setBestAgeSort] = useState<BestAgeSort>("newest");
  const [bestWindowLoaded, setBestWindowLoaded] = useState(() => loaderBestScores.length > 0);
  const [keyPpTail, setKeyPpTail] = useState<LivePlayerKeymodePpTail | null>(null);
  /* Which keymodes the tail holds, so the chip strip is whole on the first
     paint: a keymode can live entirely below the osu! window, and 16K and 18K
     appearing a beat after the rest is a flicker on every refresh. The
     snapshot carries them, and null means no snapshot has said yet, which is
     what makes the standalone fetch below a fallback rather than a second
     source. */
  const [keyPpKeyCounts, setKeyPpKeyCounts] = useState<number[] | null>(() => loaderSnapshot?.keymodeKeyCounts ?? null);
  /* "idle" until something asks for the tail, then "loading" until it answers.
     The modal shows nothing but a skeleton while it is loading: a total that
     lands and then grows is worse than a total that arrives late. */
  const [keyPpTailState, setKeyPpTailState] = useState<"idle" | "loading" | "ready" | "unavailable">("idle");
  /* Whether `best` holds the whole 200-play window rather than the 50 the SSR
     loader ships. The loader computes its insights before trimming, so they are
     full-window either way; anything that recomputes them from `best` has to
     wait for this or it would shrink them to the 50 on screen. */
  const [bestWindowComplete, setBestWindowComplete] = useState(false);
  const [waitingForSnapshotBest, setWaitingForSnapshotBest] = useState(() => loaderBestScores.length === 0);
  const [avatarOpen, setAvatarOpen] = useState(false);
  const [modModalOpen, setModModalOpen] = useState(false);
  const [includeNoModUsage, setIncludeNoModUsage] = useState(false);
  const [hoveredMod, setHoveredMod] = useState<string | null>(null);
  const [bpmModalOpen, setBpmModalOpen] = useState(false);
  const [ppModalOpen, setPpModalOpen] = useState(false);
  const [keyPpModalOpen, setKeyPpModalOpen] = useState(false);
  const [ppDistributionMode, setPpDistributionModeState] = useState<PpDistributionMode>(() =>
    readPpDistributionModePreference(),
  );
  const [ppKeyFilter, setPpKeyFilter] = useState<KeyFilter>("all");
  // The score a row was clicked on; its details take over the modal layer
  // instead of the row sending everyone off to osu!.
  const [detailScore, setDetailScore] = useState<OsuScore | null>(null);
  const [recentPlayAt, setRecentPlayAt] = useState<string | null>(null);
  const [recentHasMore, setRecentHasMore] = useState(false);
  const [bestVisibleCount, setBestVisibleCount] = useState(INITIAL_SCORE_BATCH_SIZE);
  const [recentVisibleCount, setRecentVisibleCount] = useState(INITIAL_SCORE_BATCH_SIZE);
  const tabsRailRef = useRef<HTMLDivElement | null>(null);
  const loadedProfileKeyRef = useRef<string | null>(null);
  const keyPpTailRequestedRef = useRef<number | null>(null);
  /* Mirrors keyPpTail for the two callbacks that rebuild insights off their own
     fetches. Without it, a snapshot or window load that lands after the merge
     would recompute window-only totals and drop the tracked plays back out,
     which is the 6,150 -> 5,010 flip. */
  const keyPpTailRef = useRef<LivePlayerKeymodePpTail | null>(null);
  const recentOsuRequestRef = useRef(0);
  const ppManiaBestScores = useMemo(
    () => best.filter((score) => score.beatmap?.mode === "mania"),
    [best],
  );
  const ppAvailableKeyModes = useMemo(
    () => getAvailableKeyModes(ppManiaBestScores),
    [ppManiaBestScores],
  );
  const ppKeyFilterActive: KeyFilter =
    ppKeyFilter !== "all" && !ppAvailableKeyModes.includes(ppKeyFilter) ? "all" : ppKeyFilter;
  const ppModalDistribution = useMemo(() => {
    const scoped = ppManiaBestScores.filter((score) => matchesKeyFilter(score, ppKeyFilterActive));
    const ppValues = scoped
      .map((score) => score.pp)
      .filter((pp): pp is number => pp != null && pp > 0)
      .sort((a, b) => b - a);
    return {
      bands: buildPpDistribution(ppValues),
      cumulative: buildPpCumulativeDistribution(scoped),
      top: ppValues[0] ?? null,
      bottom: ppValues.length ? ppValues[ppValues.length - 1] : null,
    };
  }, [ppManiaBestScores, ppKeyFilterActive]);
  const setPpDistributionMode = useCallback((mode: PpDistributionMode) => {
    setPpDistributionModeState(mode);
    writePpDistributionModePreference(mode);
  }, []);

  // Read after mount so SSR and hydration stay byte-identical; a locally seeded
  // tracked play only takes over once the client can read the navigation cache.
  useLayoutEffect(() => {
    setRecentPlayAt(readPlayerRecentPlay(username));
  }, [username]);

  useLayoutEffect(() => {
    const resetScroll = () => window.scrollTo({ top: 0, left: 0, behavior: "auto" });
    resetScroll();

    // TanStack's scroll restoration and mobile Safari's viewport settling both
    // happen around this same frame, so repeat once after layout has committed.
    const frame = window.requestAnimationFrame(resetScroll);
    return () => window.cancelAnimationFrame(frame);
  }, [username]);

  useEffect(() => {
    if (!avatarOpen && !modModalOpen && !bpmModalOpen && !ppModalOpen && !keyPpModalOpen && !detailScore) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setAvatarOpen(false);
        setModModalOpen(false);
        setBpmModalOpen(false);
        setPpModalOpen(false);
        setKeyPpModalOpen(false);
        setDetailScore(null);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [avatarOpen, modModalOpen, bpmModalOpen, ppModalOpen, keyPpModalOpen, detailScore]);

  /* The plays this site tracked below this player's osu! top-200 window. Asked
     for on the first hover or open of the Key Split card, never with the
     profile: nothing else reads them, most visits never open it, and a heavy
     profile's tail is a few thousand plays. Hovering is what usually pays for
     it, so the modal is already holding the answer by the time it opens. A
     profile with none (an untracked country, no live backend) keeps the
     window-only totals it always had. */
  const loadKeyPpTail = useCallback(() => {
    const userId = user?.id;
    if (!userId || !isLiveBackendConfigured()) {
      setKeyPpTailState("unavailable");
      return;
    }
    if (keyPpTailRequestedRef.current === userId) return;
    keyPpTailRequestedRef.current = userId;
    setKeyPpTailState("loading");
    fetchLivePlayerKeymodePpDirect(userId)
      .then((tail) => {
        if (keyPpTailRequestedRef.current !== userId) return;
        keyPpTailRef.current = tail;
        setKeyPpTail(tail);
        setKeyPpTailState("ready");
      })
      .catch(() => {
        if (keyPpTailRequestedRef.current !== userId) return;
        // Let the next open try again rather than pinning the failure.
        keyPpTailRequestedRef.current = null;
        setKeyPpTailState("unavailable");
      });
  }, [user?.id]);

  useEffect(() => {
    if (keyPpModalOpen) loadKeyPpTail();
  }, [keyPpModalOpen, loadKeyPpTail]);

  /* Only for a snapshot that predates the field, since a response cached
     before the backend started sending it has none. Key counts only: a few
     hundred bytes and one indexed read, against the megabyte of plays the full
     tail is. A failure leaves the strip with the keymodes the window named. */
  useEffect(() => {
    const userId = user?.id;
    if (keyPpKeyCounts !== null || !userId || !isLiveBackendConfigured()) return;
    let active = true;
    fetchLivePlayerKeymodePpKeysDirect(userId)
      .then((keys) => {
        if (active) setKeyPpKeyCounts(keys.keyCounts);
      })
      .catch(() => {});
    return () => { active = false; };
  }, [keyPpKeyCounts, user?.id]);

  /* A tracked play opens the same details card a window play does, built from
     the day-best row on the spot. No fetch: 200 rows on screen must not become
     200 osu! calls, and what the row never stored stays a dash on the card. */
  const openTrackedPlayDetails = useCallback((play: LiveKeymodePpPlay) => {
    if (!user) return;
    setDetailScore(buildTrackedPlayScore(play, {
      id: user.id,
      username: user.username,
      avatar_url: user.avatar_url,
      country_code: user.country_code,
    }));
  }, [user]);

  /* Tracked plays for the keymode the Best tab is filtered to, minus every map
     the window already lists. Empty for "all", for an untracked player, and
     until the tail has been fetched.

     Also empty until the whole window is in hand. The SSR loader seeds 50
     scores, so window plays 51-200 are not in `best` yet: merging against that
     would label a play the window does hold as "tracked here" and then drop
     the row when the rest arrives. */
  const trackedPlaysForKeyFilter = useMemo(() => {
    if (keyFilter === "all" || !keyPpTail || !bestWindowComplete) return [];
    const keyCount = Number(keyFilter.replace("k", ""));
    if (!Number.isFinite(keyCount) || keyCount <= 0) return [];
    const inWindow = new Set(
      best
        .filter((score) => getBeatmapKeyCount(score.beatmap) === keyCount && !score.beatmap?.convert)
        .map((score) => Number(score.beatmap?.id)),
    );
    return keyPpTail.plays.filter((play) => play.keyCount === keyCount && !inWindow.has(play.beatmapId));
  }, [best, bestWindowComplete, keyFilter, keyPpTail]);

  /* Picking a keymode is a request for that keymode's whole list, so it pays
     for the tail the same way opening the Key Split modal does. */
  useEffect(() => {
    if (tab === "best" && keyFilter !== "all") loadKeyPpTail();
  }, [keyFilter, loadKeyPpTail, tab]);

  /* Redone once the whole window is in hand, because a keymode's own list is
     the window's plays plus the tracked ones, and a half-loaded window would
     rank them against the wrong neighbours. */
  useEffect(() => {
    if (!bestWindowComplete || !keyPpTail || keyPpTail.plays.length === 0 || best.length === 0) return;
    setProfileInsights(calculateUserProfileInsights(best, keyPpTail));
  }, [best, bestWindowComplete, keyPpTail]);

  useEffect(() => {
    const rail = tabsRailRef.current;
    const activeTab = rail?.querySelector<HTMLButtonElement>(`[data-player-tab="${tab}"]`);
    if (!rail || !activeTab) return;

    const targetLeft = activeTab.offsetLeft - (rail.clientWidth - activeTab.offsetWidth) / 2;
    rail.scrollTo({ left: Math.max(0, targetLeft), behavior: "smooth" });
  }, [tab]);

  useEffect(() => {
    let cancelled = false;
    let snapshotTimer: number | null = null;
    let metadataRetryTimer: number | null = null;
    let metadataRetryAttempt = 0;
    const hasLoaderBestScores = loaderBestScores.length > 0;
    const hasLoaderInsights = loaderProfileInsights !== null;
    const playerShell = readPlayerShell(username);
    const seededUser = loaderSnapshot?.user ?? readCachedUser(username) ?? playerShell;

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
      setBestFilters(loaderBestFilters);
      setManiaCardSkills(loaderManiaCardSkills);
      setProfileInsights(loaderProfileInsights);
      setBestWindowLoaded(hasLoaderBestScores);
      setBestWindowComplete(false);
      setKeyPpTail(null);
      setKeyPpKeyCounts(loaderSnapshot?.keymodeKeyCounts ?? null);
      keyPpTailRef.current = null;
      keyPpTailRequestedRef.current = null;
      setKeyPpTailState("idle");
      setWaitingForSnapshotBest(!hasLoaderBestScores);
      setLoadingUser(!seededUser);
      setLoadingRankHistory(!loaderSnapshot?.user);
      setLoadingInsights(!hasLoaderInsights);
    }
    setRecent([]);
    setAboutHtml(null);
    setTab(normalizePlayerTab(initialTab));
    setKeyFilter("all");
    setBestModFilter({});
    setBestSort("pp-desc");
    setBestPpSort("pp-desc");
    setBestAgeSort("newest");
    setUserError(null);
    setBestError(null);
    setRecentError(null);
    setRecentOsuError(null);
    setRecentOsuLoaded(false);
    setRecentOsuFetchedAt(null);
    setAboutError(null);
    setInsightsError(null);
    setLoadingRecent(false);
    setLoadingOsuRecent(false);
    setLoadingAbout(false);
    setRecentHasMore(false);
    setBestVisibleCount(INITIAL_SCORE_BATCH_SIZE);
    setRecentVisibleCount(INITIAL_SCORE_BATCH_SIZE);
    recentOsuRequestRef.current += 1;

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

    const applySnapshot = (result: PlayerSnapshotData | null) => {
      if (cancelled || !result) return;
      snapshotApplied = true;
      setUser((current) => profileUsersAreEquivalent(current, result.user) ? current : result.user);
      setUserError(null);
      setLoadingUser(false);
      setLoadingRankHistory(false);
      setWaitingForSnapshotBest(false);
      if (result.keymodeKeyCounts) setKeyPpKeyCounts(result.keymodeKeyCounts);
      if (result.bestScores.length > 0) {
        const dedupedScores = dedupeScores(result.bestScores);
        setBest((current) => scoreListsAreEquivalent(current, dedupedScores) ? current : dedupedScores);
        setBestFilters(buildPlayerBestFilterMetadata(dedupedScores));
        setManiaCardSkills(computeManiaSkills(dedupedScores, { globalPp: result.user.statistics?.pp }));
        setBestWindowLoaded(true);
        setBestWindowComplete(true);
        setBestError(null);
        setProfileInsights(calculateUserProfileInsights(dedupedScores, keyPpTailRef.current ?? undefined));
        setInsightsError(null);
        setLoadingInsights(false);
      }
    };

    const clearMetadataRetry = () => {
      if (metadataRetryTimer) {
        window.clearTimeout(metadataRetryTimer);
        metadataRetryTimer = null;
      }
    };

    const scheduleMetadataRetry = (snapshot: PlayerSnapshotData | null) => {
      if (!snapshot || !profileSnapshotUserMetadataIsStale(snapshot)) return;
      if (metadataRetryAttempt >= PROFILE_USER_METADATA_RETRY_DELAYS_MS.length) return;

      // Only the first rung is rate limited; once a ladder is running it plays
      // out in full. This is what stops a back-and-forth from stacking ladders.
      if (metadataRetryAttempt === 0) {
        const lastStartedAt = playerSnapshotMetadataRetryStartedAt.get(profileKey);
        if (lastStartedAt !== undefined && Date.now() - lastStartedAt < PROFILE_USER_METADATA_RETRY_COOLDOWN_MS) return;
        playerSnapshotMetadataRetryStartedAt.set(profileKey, Date.now());
      }

      const delay = PROFILE_USER_METADATA_RETRY_DELAYS_MS[metadataRetryAttempt++];
      clearMetadataRetry();
      metadataRetryTimer = window.setTimeout(() => {
        metadataRetryTimer = null;
        loadPlayerSnapshotCached(username, { bypassDataCache: true })
          .then((result) => {
            if (cancelled) return;
            applySnapshot(result);
            scheduleMetadataRetry(result);
          })
          .catch(() => {
            if (!cancelled) scheduleMetadataRetry(snapshot);
          });
      }, delay);
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
          setUserError(t`Couldn't load this player right now.`);
          setLoadingInsights(false);
        }
      })
      .finally(() => {
        if (cancelled) return;
        setLoadingRankHistory(false);
        if (!snapshotApplied && !seededUser) setLoadingUser(false);
      });

    const loadSnapshot = () => {
      loadPlayerSnapshotCached(username, {
        onRevalidated: (fresh) => {
          if (cancelled) return;
          applySnapshot(fresh);
          scheduleMetadataRetry(fresh);
        },
      })
        .then((snapshot) => {
          if (cancelled) return;
          if (snapshot) {
            applySnapshot(snapshot);
            scheduleMetadataRetry(snapshot);
            return;
          }
          setWaitingForSnapshotBest(false);
          if (!seededUser) {
            void loadFallbackUser();
            return;
          }
          setLoadingRankHistory(false);
        })
        .catch(() => {
          if (cancelled) return;
          setWaitingForSnapshotBest(false);
          if (!seededUser) {
            void loadFallbackUser();
            return;
          }
          setLoadingRankHistory(false);
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
      clearMetadataRetry();
    };
  }, [initialTab, loaderBestFilters, loaderBestScores, loaderManiaCardSkills, loaderProfileInsights, loaderSnapshot, username]);

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
          setBestFilters(buildPlayerBestFilterMetadata(dedupedScores));
          setManiaCardSkills(computeManiaSkills(dedupedScores, { globalPp: user!.statistics?.pp }));
          setBestWindowLoaded(true);
          setBestWindowComplete(true);
          setBestError(null);
          setProfileInsights(calculateUserProfileInsights(dedupedScores, keyPpTailRef.current ?? undefined));
          setInsightsError(null);
        })
        .catch(() => {
          if (cancelled) return;
          setBestError(t`Couldn't load top plays right now.`);
          setInsightsError(t`Couldn't load profile insights right now.`);
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
        setRecentError(t`Couldn't load recent scores right now.`);
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
        setAboutError(t`Couldn't load About right now.`);
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

  const handleFetchOsuRecent = useCallback(async () => {
    if (!user || loadingOsuRecent) return;
    const requestId = ++recentOsuRequestRef.current;
    setLoadingOsuRecent(true);
    setRecentOsuError(null);
    try {
      const section = await withTimeout(
        fetchLivePlayerRecentScoresDirect(user.id, "osu"),
        PLAYER_RECENT_LIVE_TIMEOUT_MS,
      );
      if (recentOsuRequestRef.current !== requestId) return;
      const fetched = Array.isArray(section.payload) ? section.payload : [];
      setRecent((current) => mergeRecentScores(current, fetched));
      setRecentHasMore(false);
      setRecentOsuLoaded(true);
      setRecentOsuFetchedAt(section.fetchedAt);
    } catch {
      if (recentOsuRequestRef.current !== requestId) return;
      setRecentOsuError(t`Couldn't load osu! recents right now.`);
    } finally {
      if (recentOsuRequestRef.current === requestId) setLoadingOsuRecent(false);
    }
  }, [loadingOsuRecent, user]);

  const relevantBestMods = bestFilters.mods;
  const bestPositionByIdentity = useMemo(() => {
    const positions = new Map<string, number>();
    best.forEach((score, index) => {
      positions.set(getScoreIdentity(score), index + 1);
    });
    return positions;
  }, [best]);

  /* How much of this profile each keymode actually is, used to decide which
     chips are worth a tap when there are more keymodes than fit. The insights
     count window plays and tracked ones together; before they land, the window
     on its own ranks the same mains first. */
  const keyModePlayCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const score of best) {
      const keyCount = getBeatmapKeyCount(score.beatmap);
      if (keyCount == null) continue;
      const key = `${keyCount}k`;
      counts[key] = (counts[key] ?? 0) + 1;
    }
    for (const bucket of profileInsights?.keyPp ?? []) {
      counts[`${bucket.keyCount}k`] = bucket.count;
    }
    return counts;
  }, [best, profileInsights]);

  /* Five keeps All plus the mains on one phone row. Past that the strip is
     wider than the screen and the chips at the end are unreachable without a
     swipe nothing announces. */
  const MAX_INLINE_KEY_MODES = 5;

  const availableKeyModes = useMemo(() => {
    const modes = new Set([...bestFilters.keyModes, ...getAvailableKeyModes(recent)]);
    // A keymode can exist entirely below the osu! window (every 5K play worth
    // less than the 200th), and the chip has to be there or the list this site
    // can show has no way to be asked for.
    for (const keyCount of keyPpKeyCounts ?? []) modes.add(`${keyCount}k`);
    for (const play of keyPpTail?.plays ?? []) modes.add(`${play.keyCount}k`);
    return [...modes].sort((a, b) => Number(a.replace("k", "")) - Number(b.replace("k", "")));
  }, [bestFilters.keyModes, keyPpKeyCounts, keyPpTail, recent]);
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
    void navigate({
      to: getPlayerTabPath(username, normalizedTab),
      state: preservePlayerCountryFlagState(showCountryFlag),
      resetScroll: false,
    });
  }, [navigate, showCountryFlag, username]);

  /* The overflow chip opens the PP by Keymode modal, which is already the full
     list of this profile's keymodes with what each is worth. Only offered when
     that modal has rows to show, so the chip can never open nothing. */
  const openKeyModeOverflow = useCallback(() => setKeyPpModalOpen(true), []);
  const keyModeOverflowHandler = (profileInsights?.keyPp.length ?? 0) > 0 ? openKeyModeOverflow : undefined;

  const handleBestSortChange = useCallback((nextSort: BestSort) => {
    setBestSort(nextSort);
    if (nextSort === "pp-desc" || nextSort === "pp-asc") {
      setBestPpSort(nextSort);
    } else {
      setBestAgeSort(nextSort);
    }
  }, []);

  if (loadingUser && !user) {
    return <PlayerPageSkeleton tab={tab} onTabChange={handleTabChange} />;
  }

  if (userError || !user) {
    return (
      <div className="flex-1 bg-osu-b5">
        <div className="max-w-[1200px] mx-auto px-5 py-16 text-center text-sm text-osu-f1">
          {userError ?? t`Player not found.`}
        </div>
      </div>
    );
  }

  const stats = user.statistics;
  const currentScores = tab === "best" ? best : recent;
  const currentVisibleCount = tab === "best" ? bestVisibleCount : recentVisibleCount;
  const keyFilteredScores = currentScores.filter((score) =>
    tab === "best" ? matchesBestKeyFilter(score, keyFilter) : matchesKeyFilter(score, keyFilter));
  const filteredScores = tab === "best"
    ? sortBestScores(
      keyFilteredScores.filter((score) => matchesModFilter(score, bestModFilter)),
      bestSort,
    )
    : keyFilteredScores;
  /* One keymode's whole list, not the slice of it osu! had room for. Picking a
     keymode is the moment the shared 200-play window stops being the right
     answer, so the plays this site tracked below it join the rows here, in the
     same order and under one ranking. "All" is left alone: there the window is
     exactly what osu! ranks, and 200 more rows under it would be a different
     list wearing the same name. */
  /* The keymode's list itself: window plays and tracked ones under one pp
     ranking, cut at the same 200 the Key Split modal's total is built from.
     Ranked and cut before the mod filter, so filtering narrows the list rather
     than pulling in the 201st play to backfill it, and so the two numbers on
     screen describe the same set of plays. */
  const keymodeListRows: BestListRow[] | null = tab === "best" && trackedPlaysForKeyFilter.length > 0
    ? sortBestListRows(
      [
        ...keyFilteredScores.map((score) => ({ kind: "score" as const, score })),
        ...trackedPlaysForKeyFilter.map((play) => ({ kind: "tracked" as const, play })),
      ],
      "pp-desc",
    ).slice(0, KEY_PP_LIST_LIMIT)
    : null;
  const bestListRows: BestListRow[] = keymodeListRows
    ? sortBestListRows(keymodeListRows.filter((row) => bestListRowMatchesModFilter(row, bestModFilter)), bestSort)
    : filteredScores.map((score) => ({ kind: "score" as const, score }));
  const visibleRows = bestListRows.slice(0, currentVisibleCount);
  const scoreRowLayout = getScoreRowLayout(visibleRows);
  /* With tracked plays in, the row numbers have to rank the merged list: a
     window play's place in the profile-wide top 200 would read as a different
     scale from the tracked row beside it. */
  const keymodeListPositions = new Map<string, number>();
  if (keymodeListRows) {
    keymodeListRows.forEach((row, index) => {
      keymodeListPositions.set(bestListRowKey(row), index + 1);
    });
  }
  const loadingBest = best.length === 0 && !bestWindowLoaded && !bestError;
  const loadingScores = tab === "best" ? loadingBest : loadingRecent;
  const scoresError = tab === "best" ? bestError : recentError;
  const currentHasMore = tab === "best" ? !bestWindowLoaded : recentHasMore;
  const isLoadingMoreCurrentTab = false;
  const canShowMore = tab === "best"
    ? bestWindowLoaded && bestListRows.length > visibleRows.length
    : filteredScores.length > visibleRows.length || recentHasMore;
  const isSettlingInitialFilteredView =
    !loadingScores &&
    currentVisibleCount === INITIAL_SCORE_BATCH_SIZE &&
    bestListRows.length < INITIAL_SCORE_BATCH_SIZE &&
    currentHasMore;
  /* A keymode list is the window's plays and the tracked ones together, so it
     waits for both rather than painting half of it and inserting the rest a
     frame later. Sub-200ms in practice, and the prefetch usually beats it.
     The window half counts too: the SSR loader seeds only 50 of its 200
     scores, and ranking tracked plays against those puts rows in places they
     do not keep. */
  const isWaitingForTrackedPlays =
    tab === "best" &&
    keyFilter !== "all" &&
    (keyPpTailState === "idle" || keyPpTailState === "loading" || !bestWindowComplete);
  const scoreListState = loadingScores
    ? "loading"
    : isWaitingForTrackedPlays || isSettlingInitialFilteredView
      ? "settling"
      : visibleRows.length > 0
        ? "loaded"
        : scoresError
          ? "error"
          : "empty";

  const avatarSrc = user.avatar_url;
  const profileCountryCode = isSupportedCountryCode(user.country_code)
    ? user.country_code.trim().toUpperCase()
    : null;
  const profileCountryName = profileCountryCode ? displayCountryName(profileCountryCode, locale) : null;
  // showCountryFlag rides on history state, which SSR can't see but the
  // browser restores on reload — render the flag only once hydration is done
  // so the server and first client render agree (React #418 otherwise).
  const showProfileCountryFlag = hasHydrated && showCountryFlag && profileCountryCode && profileCountryName;
  // A play we just watched land beats osu!'s `last_visit`, which only tracks
  // website visits and can read weeks stale for someone mid-session.
  const seenPlayingNow = recentPlayAt != null && playedWithinOnlineWindow(recentPlayAt);
  const isOnlineNow = user.is_online || seenPlayingNow;

  const coverImage = user.cover?.url || user.cover_url || null;
  const peakRank = user.rank_highest?.rank ?? null;
  const peakRankDate = user.rank_highest?.updated_at ?? null;
  const awaitingPeak = loadingRankHistory && !peakRank;
  const rankHistoryPoints = (user.rank_history?.data ?? []).filter((point) => point > 0);
  // Positive delta = rank improved (the number went down).
  const rankDelta90d = rankHistoryPoints.length >= 2
    ? rankHistoryPoints[0] - rankHistoryPoints[rankHistoryPoints.length - 1]
    : null;
  const showTungTungSahur = user.username.toLowerCase() === "sebasrj";
  // The tab strip sits flush on the section edge unless a filter/sort bar
  // follows it, which then needs the breathing room back.
  const hasTabControls = tab === "recent" || (tab === "best" && bestWindowLoaded && best.length > 0);
  const ppVariants = (stats.variants ?? [])
    .filter((variant) => variant.mode === "mania" && variant.pp > 0)
    .sort((a, b) => a.variant.localeCompare(b.variant));

  const heroMeta: ReactNode[] = [
    <a
      key="osu"
      href={`https://osu.ppy.sh/users/${user.id}/mania`}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 rounded-full bg-osu-pink/20 px-2 py-0.5 font-semibold text-osu-pink-light transition-colors duration-150 hover:bg-osu-pink/35"
    >
      <Trans>osu! profile</Trans>
      <svg className="h-2.5 w-2.5" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3.5 1.5h7v7" /><path d="M10.5 1.5 1.5 10.5" /></svg>
    </a>,
  ];
  if (!isOnlineNow && user.last_visit) {
    heroMeta.push(
      // Relative to Date.now(), so SSR and hydration can land on different
      // sides of a minute boundary; let the client text win.
      <span key="seen" title={new Date(user.last_visit).toLocaleString("en-US")} suppressHydrationWarning>
        <Trans>Last seen {formatDetailedTimeAgo(user.last_visit, locale)}</Trans>
      </span>,
    );
  }
  // Joined date and playstyle are static profile facts, not live status, so
  // they sit on the stat rail with the other facts instead of trailing the
  // name alongside a link and a presence readout.
  const joinedValue = !profileStatsProjectedOnly && hasValidDate(user.join_date) ? formatDate(user.join_date) : null;
  const playstyleValue = user.playstyle?.length ? user.playstyle.join(", ") : null;

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
                <Trans>View osu! profile</Trans>
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
                aria-label={t`Close`}
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
                        <div className="text-[10px] uppercase tracking-wider text-osu-f1 font-semibold">{t`Mod Usage`}</div>
                        <div className="mt-0.5 text-[11px] text-osu-f1/60 flex items-center gap-1.5 flex-wrap">
                          <span>{includeNoModUsage
                            ? t`across ${usageSampleSize} top plays`
                            : t`across ${usageSampleSize} modded top plays`}</span>
                          {stacks > 0 && (
                            <span
                              className="px-1.5 py-[1px] rounded bg-osu-b3/40 text-[9px] font-semibold uppercase tracking-wider text-osu-f1 cursor-help"
                              title={t`${stacks} extra mod-uses from plays that stack mods (e.g. DT+MR). Slice sizes show share of mod-uses; percentages show share of plays.`}
                            >
                              <Trans>+{stacks} stacked</Trans>
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
                          title={includeNoModUsage ? t`NM is included in mod usage` : t`NM is excluded from mod usage`}
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
                              <Trans>{focused.count} of {usageSampleSize}</Trans>
                            </text>
                          </>
                        ) : (
                          <>
                            <text x={cx} y={cy + 2} textAnchor="middle" fill="#fff" style={{ fontSize: 28, fontWeight: 800 }}>
                              {usageSampleSize}
                            </text>
                            <text x={cx} y={cy + 20} textAnchor="middle" fill="var(--color-osu-f1)" style={{ fontSize: 9, letterSpacing: 1.5, textTransform: "uppercase" }}>
                              {includeNoModUsage ? t`top plays` : t`modded plays`}
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
                aria-label={t`Close`}
                className="absolute top-3 right-3 z-20 w-7 h-7 flex items-center justify-center rounded-full text-osu-f1 hover:text-white hover:bg-osu-b3/50 transition-colors cursor-pointer"
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M1 1l12 12M13 1L1 13" />
                </svg>
              </button>
              <div className="relative z-10 max-h-[85vh] overflow-y-auto p-5 [scrollbar-gutter:stable]">
                <div className="text-[10px] uppercase tracking-wider text-osu-f1 font-semibold">{t`BPM Breakdown`}</div>
                <div className="mt-0.5 text-[11px] text-osu-f1/60">
                  <Trans>across {profileInsights.sampleSize} top plays · note-density tempo where available · adjusted for rate mods · weighted toward your highest plays</Trans>
                </div>

                <div className="mt-4 flex items-baseline gap-2">
                  <span className="text-2xl font-bold text-white">{Math.round(profileInsights.medianBpm)}</span>
                  <span className="text-[11px] text-osu-f1">{t`median BPM`}</span>
                </div>

                {profileInsights.bpmByKeyMode && profileInsights.bpmByKeyMode.length > 1 && (
                  <div className="mt-4">
                    <div className="text-[10px] uppercase tracking-wider text-osu-f1 font-semibold mb-2">{t`Median by Keymode`}</div>
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
                    <div className="text-[10px] uppercase tracking-wider text-osu-f1 font-semibold mb-2">{t`Range`}</div>
                    <div className="space-y-2">
                      <BpmExtremeRow label={t`Slowest`} bpm={profileInsights.bpmRange.min} snapshot={profileInsights.bpmRange.minScore} />
                      <BpmExtremeRow label={t`Fastest`} bpm={profileInsights.bpmRange.max} snapshot={profileInsights.bpmRange.maxScore} />
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
              aria-label={t`PP distribution`}
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
                aria-label={t`Close`}
                className="absolute top-3 right-3 z-20 w-7 h-7 flex items-center justify-center rounded-full text-osu-f1 hover:text-white hover:bg-osu-b3/50 transition-colors cursor-pointer"
              >
                <X size={14} />
              </button>
              <div className="relative z-10 max-h-[85vh] overflow-y-auto p-5 [scrollbar-gutter:stable]">
                {(() => {
                  const ppDistribution = ppModalDistribution.bands;
                  const ppCumulativeDistribution = ppModalDistribution.cumulative;
                  const ppTotal = ppDistribution[0]?.total ?? 0;
                  const ppTop = ppModalDistribution.top ?? profileInsights.ppRange.top;
                  const ppBottom = ppModalDistribution.bottom ?? profileInsights.ppRange.bottom;
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
                          <div className="text-[10px] uppercase tracking-wider text-osu-f1 font-semibold">{t`PP Distribution`}</div>
                          <div className="mt-0.5 text-[11px] text-osu-f1/60">
                            <Trans>across {ppTotal} profile top plays with PP</Trans>
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
                                {mode === "bands" ? t`Bands` : t`Cumulative`}
                              </button>
                            );
                          })}
                        </div>
                      </div>

                      {ppAvailableKeyModes.length > 1 && (
                        <div className="mt-3">
                          <KeyModeControl
                            availableKeyModes={ppAvailableKeyModes}
                            keyFilter={ppKeyFilterActive}
                            onChangeKeyFilter={setPpKeyFilter}
                          />
                        </div>
                      )}

                      <div className="mt-4 flex flex-wrap items-baseline gap-x-2 gap-y-1">
                        <span className="text-2xl font-bold text-osu-pink-light tabular-nums">{Math.round(ppTop)}</span>
                        <span className="text-[11px] text-osu-f1">{t`top pp`}</span>
                        <span className="text-osu-f1/40">/</span>
                        <span className="text-xl font-bold text-white tabular-nums">{Math.round(ppBottom)}</span>
                        <span className="text-[11px] text-osu-f1">{t`bottom pp`}</span>
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
                                  <span className="text-[10px] text-osu-f1"><Plural value={entry.count} one="play" other="plays" /></span>
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

      {/* Keymode PP modal */}
      <AnimatePresence>
        {keyPpModalOpen && profileInsights && profileInsights.keyPp.length > 0 && (
          <motion.div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 sm:backdrop-blur-sm cursor-pointer p-4"
            onClick={() => setKeyPpModalOpen(false)}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
          >
            <motion.div
              role="dialog"
              aria-modal="true"
              aria-label={t`PP by keymode`}
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
                onClick={() => setKeyPpModalOpen(false)}
                aria-label={t`Close`}
                className="absolute top-3 right-3 z-20 w-7 h-7 flex items-center justify-center rounded-full text-osu-f1 hover:text-white hover:bg-osu-b3/50 transition-colors cursor-pointer"
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M1 1l12 12M13 1L1 13" />
                </svg>
              </button>
              <div className="relative z-10 max-h-[85vh] overflow-y-auto p-5 [scrollbar-gutter:stable]">
                <div className="text-[10px] uppercase tracking-wider text-osu-f1 font-semibold">{t`PP by Keymode`}</div>
                <div className="mt-0.5 text-[11px] text-osu-f1/60">
                  <Trans>each keymode weighted against its own plays, the way osu! totals 4K and 7K</Trans>
                </div>

                {keyPpTailState === "loading" ? (
                  /* No half-answer: a total that appears and then grows once
                     the tracked plays land reads as a bug, so the rows wait. */
                  <div className="mt-4 space-y-3" aria-busy="true">
                    {profileInsights.keyPp.map((bucket) => (
                      <div key={bucket.keyCount} className="flex items-center gap-3">
                        <span className={`w-8 shrink-0 text-xs font-bold tabular-nums ${KEYMODE_TEXT_COLORS[bucket.keyCount] ?? "text-white"}`}>
                          {bucket.keyCount}K
                        </span>
                        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-osu-b3/40">
                          <div className="h-full w-1/3 animate-pulse rounded-full bg-osu-b3" />
                        </div>
                        <div className="w-[112px] shrink-0">
                          <div className="ml-auto h-4 w-20 animate-pulse rounded bg-osu-b3/60" />
                          <div className="ml-auto mt-1.5 h-2.5 w-12 animate-pulse rounded bg-osu-b3/40" />
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  (() => {
                    const buckets = profileInsights.keyPp;
                    const topPp = buckets.reduce((top, bucket) => Math.max(top, bucket.weightedPp), 0);
                    const hasFloor = buckets.some(isKeyPpFloor);
                    return (
                      <>
                        <div className="mt-4 space-y-3">
                          {/* A row is also how you pick that keymode: it is the
                              one place that lists every keymode this profile has,
                              which is what the chip strip sends the overflow to. */}
                          {buckets.map((bucket) => (
                            <button
                              key={bucket.keyCount}
                              type="button"
                              onClick={() => {
                                setKeyFilter(`${bucket.keyCount}k`);
                                handleTabChange("best");
                                setKeyPpModalOpen(false);
                              }}
                              title={t`Show ${bucket.keyCount}K plays`}
                              className="flex w-full cursor-pointer items-center gap-3 rounded-lg px-1 py-0.5 text-left transition-colors hover:bg-osu-b3/30"
                            >
                              <span className={`w-8 shrink-0 text-xs font-bold tabular-nums ${KEYMODE_TEXT_COLORS[bucket.keyCount] ?? "text-white"}`}>
                                {bucket.keyCount}K
                              </span>
                              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-osu-b3/40">
                                <div
                                  className={`h-full rounded-full ${KEYMODE_BAR_COLORS[bucket.keyCount] ?? "bg-osu-b1"}`}
                                  style={{ width: `${topPp > 0 ? (bucket.weightedPp / topPp) * 100 : 0}%` }}
                                />
                              </div>
                              <div className="w-[112px] shrink-0 text-right">
                                <div className="text-[17px] font-black leading-none tabular-nums text-white">
                                  {formatNumber(Math.round(bucket.weightedPp))}
                                  {isKeyPpFloor(bucket) && <span className="text-osu-f1">+</span>}
                                  <span className="ml-1 text-[11px] font-bold text-osu-f1">pp</span>
                                </div>
                                <div className="mt-1 text-[11px] tabular-nums text-osu-f1">
                                  <Plural value={bucket.count} one={`${formatNumber(bucket.count)} play`} other={`${formatNumber(bucket.count)} plays`} />
                                </div>
                              </div>
                            </button>
                          ))}
                        </div>

                        <div className="mt-4 space-y-1 text-[11px] text-osu-f1">
                          {hasFloor && (
                            <div>
                              <Trans>A + reads as "at least": osu! serves no more than your top 200 plays, so a keymode with plays under {formatNumber(Math.round(profileInsights.keyPpCutoff))}pp is only counted as far as they go.</Trans>
                            </div>
                          )}
                          {profileInsights.keyPpTracked > 0 && (
                            <div>
                              <Plural
                                value={profileInsights.keyPpTracked}
                                one={`# play this site tracked below your top 200 counts here too, so each keymode gets its own list instead of sharing one.`}
                                other={`# plays this site tracked below your top 200 count here too, so each keymode gets its own list instead of sharing one.`}
                              />
                            </div>
                          )}
                          {profileInsights.keyPpConverts > 0 && (
                            <div>
                              <Plural
                                value={profileInsights.keyPpConverts}
                                one={`# convert is left out, as osu! leaves converts out of its own keymode totals.`}
                                other={`# converts are left out, as osu! leaves converts out of its own keymode totals.`}
                              />
                            </div>
                          )}
                          <div>
                            <Trans>Bonus pp for playcount is not counted here, so these read a little under the 4K and 7K totals on an osu! profile.</Trans>
                          </div>
                        </div>
                      </>
                    );
                  })()
                )}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Score details modal */}
      <AnimatePresence>
        {detailScore && (
          <ScoreDetailModal score={detailScore} onClose={() => setDetailScore(null)} />
        )}
      </AnimatePresence>

      {/* Hero: cover art, identity, and the headline ranks share one band, with
          the 90-day rank trend drawn edge to edge underneath them. */}
      <header className="relative isolate overflow-hidden bg-osu-b4">
        {coverImage && (
          <img
            src={coverImage}
            alt=""
            className="absolute inset-0 h-full w-full object-cover"
            style={{ filter: "brightness(0.34) saturate(1.15)" }}
          />
        )}
        <div className="absolute inset-0 bg-[radial-gradient(135%_120%_at_12%_0%,rgba(0,0,0,0.25),rgba(0,0,0,0.82))]" />
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-32 bg-gradient-to-b from-transparent to-osu-b5" />
        <RankTrendline history={rankHistoryPoints} />

        <div className="relative mx-auto max-w-[1200px] px-4 pt-8 pb-7 sm:px-5 sm:pt-12 sm:pb-9">
          <div className="flex items-center gap-4 sm:gap-5">
            <button
              type="button"
              onClick={() => setAvatarOpen(true)}
              className="h-[84px] w-[84px] flex-shrink-0 cursor-pointer overflow-hidden rounded-2xl shadow-[0_10px_30px_rgba(0,0,0,0.45)] ring-2 ring-white/15 transition duration-150 hover:ring-osu-pink/70 sm:h-[124px] sm:w-[124px]"
            >
              <img
                src={avatarSrc}
                alt={`${user.username}'s avatar`}
                className="h-full w-full object-cover"
                loading="lazy"
              />
            </button>
            <div className="min-w-0 flex-1">
              <h1 className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
                {/* `truncate` clips at the padding box, and with leading-none the
                    box is tighter than the ink: a capital J overhangs it on the
                    left and below. The padding/-margin pair buys room on every
                    side without moving anything. */}
                <UsernameText username={user.username} avatarUrl={user.avatar_url} className="min-w-0 truncate p-2 -m-2 text-[26px] font-black leading-none text-white sm:text-[40px]" />
                {showProfileCountryFlag ? (
                  <Link
                    to="/"
                    search={{ country: profileCountryCode }}
                    className="inline-flex shrink-0 items-center rounded-[3px] ring-1 ring-white/20 transition hover:ring-osu-pink-light/70 focus:outline-none focus-visible:ring-2 focus-visible:ring-osu-pink-light"
                    title={t`Open ${profileCountryName} home`}
                    aria-label={t`Open ${profileCountryName} home`}
                  >
                    <CountryFlag code={profileCountryCode} size="md" decorative />
                  </Link>
                ) : null}
                {user.is_supporter && (
                  <span className="inline-flex h-[22px] items-center justify-center rounded-full bg-osu-pink px-2" title={t`osu! Supporter`}>
                    <img src="/images/icons/supporter.svg" alt={t`Supporter`} className="h-3 w-3 brightness-0 invert" />
                  </span>
                )}
                {isOnlineNow ? (
                  <span
                    className="h-2 w-2 shrink-0 rounded-full bg-osu-green"
                    title={user.is_online || !recentPlayAt ? t`Online` : t`Set a play ${formatDetailedTimeAgo(recentPlayAt, locale)}`}
                  />
                ) : null}
              </h1>
              <div className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-white/50">
                {heroMeta.map((item, index) => (
                  <span key={index} className="inline-flex items-center gap-2">
                    {item}
                  </span>
                ))}
              </div>
            </div>
          </div>

          {/* The keycap easter egg stands on the rail below and leans into this
              corner, so on narrow screens the numbers step out of its way. */}
          <div className={`mt-7 grid grid-cols-2 gap-x-6 gap-y-5 sm:mt-9 sm:flex sm:flex-wrap sm:items-end sm:gap-x-12 sm:pr-0 ${showTungTungSahur ? "pr-16" : ""}`}>
            <HeroStat
              label={t`Global`}
              value={stats.global_rank ? `#${formatNumber(stats.global_rank)}` : "-"}
              sub={rankDelta90d != null && rankDelta90d !== 0 ? (
                <span className={`inline-flex items-center gap-1 ${rankDelta90d > 0 ? "text-osu-green-light" : "text-osu-red-light"}`}>
                  <svg width="7" height="6" viewBox="0 0 7 6" className="flex-shrink-0" aria-hidden>
                    <path d={rankDelta90d > 0 ? "M3.5 0 L7 6 L0 6 Z" : "M3.5 6 L0 0 L7 0 Z"} fill="currentColor" />
                  </svg>
                  <span className="tabular-nums">{formatNumber(Math.abs(rankDelta90d))}</span>
                  <span className="text-white/40">{t`in 90d`}</span>
                </span>
              ) : null}
            />
            <HeroStat
              label={t`Country`}
              value={stats.country_rank ? `#${formatNumber(stats.country_rank)}` : "-"}
              valueClassName="text-osu-pink-light"
              sub={profileCountryName ?? (user.country_code || null)}
            />
            <HeroStat
              label={t`Peak`}
              value={awaitingPeak ? <span className="skeleton-pulse block h-[26px] w-24 rounded sm:h-[34px] sm:w-32" /> : peakRank ? `#${formatNumber(peakRank)}` : "-"}
              valueClassName={peakRank ? getRankTierClass(peakRank) || "text-white" : "text-white"}
              sub={peakRank && peakRankDate ? t`achieved ${formatDate(peakRankDate)}` : null}
            />
            <HeroStat
              label={t`Performance`}
              value={`${formatNumber(Math.round(stats.pp))}pp`}
              valueClassName="text-osu-yellow"
              sub={ppVariants.length >= 2 ? (
                <span className="inline-flex items-center gap-2.5 tabular-nums">
                  {ppVariants.map((variant) => (
                    <span
                      key={variant.variant}
                      title={[
                        variant.global_rank != null ? t`#${formatNumber(variant.global_rank)} global` : null,
                        variant.country_rank != null ? t`#${formatNumber(variant.country_rank)} country` : null,
                      ].filter(Boolean).join("  •  ") || undefined}
                    >
                      <span className="font-bold uppercase text-white/35">{variant.variant} </span>
                      <span className="font-semibold text-white/70">{formatNumber(Math.round(variant.pp))}</span>
                    </span>
                  ))}
                </span>
              ) : null}
            />
          </div>
        </div>
      </header>

      {/* Stats */}
      <div className="bg-osu-b5">
        <div className={`max-w-[1200px] mx-auto px-4 sm:px-5 ${hasTabControls ? "pb-4" : ""}`}>
          {/* Play totals and the grade tally share one flat rail: no boxes, just
              the numbers with a hairline under them. */}
          <div className="relative flex flex-wrap items-center gap-x-8 gap-y-5 border-b border-osu-b3/25 py-5 sm:gap-x-12">
            {showTungTungSahur && <TungTungSahurKeycap />}
            <RailStat label={t`Accuracy`} value={profileStatsProjectedOnly ? "-" : formatAccuracy(stats.hit_accuracy / 100)} />
            <RailStat label={t`Play Count`} value={profileStatsProjectedOnly ? "-" : formatNumber(stats.play_count)} />
            <RailStat label={t`Play Time`} value={profileStatsProjectedOnly || stats.play_time == null ? "-" : t`${formatNumber(Math.floor(stats.play_time / 3600))}h`} />
            {/* One quiet line rather than two label/value blocks: at rail-stat
                weight these claimed a whole row to themselves on mobile, which
                is more than a join date and a playstyle are worth. */}
            {(joinedValue || playstyleValue) && (
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-osu-f1">
                {joinedValue && (
                  <span><Trans>Joined <strong className="font-semibold text-osu-l2">{joinedValue}</strong></Trans></span>
                )}
                {joinedValue && playstyleValue && <span className="text-osu-b1">·</span>}
                {playstyleValue && (
                  <span><Trans>Plays with <strong className="font-semibold capitalize text-osu-l2">{playstyleValue}</strong></Trans></span>
                )}
              </div>
            )}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 sm:ml-auto">
              {([
                ["SSH", stats.grade_counts.ssh],
                ["SS", stats.grade_counts.ss],
                ["SH", stats.grade_counts.sh],
                ["S", stats.grade_counts.s],
                ["A", stats.grade_counts.a],
              ] as [string, number][]).map(([grade, count]) => (
                <div key={grade} className="flex items-center gap-1.5">
                  <GradeImg grade={grade} size={26} />
                  <span className="text-xs font-semibold tabular-nums text-osu-f1">{profileStatsProjectedOnly ? "-" : formatNumber(count)}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Profile insights */}
          <div className="py-5">
            {loadingInsights ? (
              <InsightsSkeleton />
            ) : insightsError ? (
              <div className="rounded-xl border border-osu-b3/20 bg-osu-b4 px-4 py-3 text-sm text-osu-f1">
                {insightsError}
              </div>
            ) : displayedProfileInsights && displayedProfileInsights.sampleSize > 0 ? (() => {
              const profileInsights = displayedProfileInsights;
              const hasPpDistribution = profileInsights.ppRange != null && profileInsights.ppDistribution.length > 0;
              const hasKeyPp = profileInsights.keyPp.length > 0;
              return (
              <div className="space-y-3">
                {/* One panel, four cells: the 1px gaps show the parent through as
                    hairlines so this reads as a single object, not four boxes. */}
                <div className={INSIGHT_PANEL_CLASS}>
                  <KeySplitCard
                    keySplit={profileInsights.keySplit}
                    sampleSize={profileInsights.sampleSize}
                    onOpen={hasKeyPp ? () => setKeyPpModalOpen(true) : undefined}
                    onPrefetch={hasKeyPp ? loadKeyPpTail : undefined}
                  />
                  <div
                    className={`${INSIGHT_CELL_CLASS} group ${profileInsights.mostUsedMod ? INSIGHT_CELL_INTERACTIVE_CLASS : ""}`}
                    onClick={profileInsights.mostUsedMod ? () => setModModalOpen(true) : undefined}
                  >
                    <div className="flex items-center justify-between">
                      <div className={INSIGHT_LABEL_CLASS}>{t`Most Used Mod`}</div>
                      {profileInsights.mostUsedMod && <ExpandHint />}
                    </div>
                    {profileInsights.mostUsedMod ? (
                      <>
                        <div className="mt-2 flex items-center gap-2">
                          <ModBadge mod={profileInsights.mostUsedMod.label} />
                          <span className="text-[26px] font-black leading-none text-white">{profileInsights.mostUsedMod.label}</span>
                        </div>
                        <div className="mt-auto flex items-center gap-2 pt-2.5">
                          <div className="h-1 flex-1 overflow-hidden rounded-full bg-osu-b3/50">
                            <div
                              className="h-full rounded-full bg-osu-yellow"
                              style={{ width: `${Math.round((profileInsights.mostUsedMod.count / profileInsights.mostUsedMod.total) * 100)}%` }}
                            />
                          </div>
                          <span className="text-[10px] tabular-nums text-osu-f1">
                            {Math.round((profileInsights.mostUsedMod.count / profileInsights.mostUsedMod.total) * 100)}%
                          </span>
                        </div>
                      </>
                    ) : (
                      <div className="mt-2 text-sm text-osu-f1">{t`No mod preference`}</div>
                    )}
                  </div>
                  <div
                    className={`${INSIGHT_CELL_CLASS} group ${profileInsights.medianBpm != null ? INSIGHT_CELL_INTERACTIVE_CLASS : ""}`}
                    onClick={profileInsights.medianBpm != null ? () => setBpmModalOpen(true) : undefined}
                  >
                    <div className="flex items-center justify-between">
                      <div className={INSIGHT_LABEL_CLASS}>{t`Median BPM`}</div>
                      {profileInsights.medianBpm != null && <ExpandHint />}
                    </div>
                    {profileInsights.medianBpm != null ? (
                      <>
                        <div className="mt-2 flex items-baseline gap-1.5">
                          <span className="text-[26px] font-black leading-none tabular-nums text-white">{Math.round(profileInsights.medianBpm)}</span>
                          <span className="text-[11px] font-semibold text-osu-f1">{t`BPM`}</span>
                        </div>
                        {profileInsights.bpmRange && (
                          <div className="mt-auto pt-2.5 text-[11px] tabular-nums text-osu-f1">
                            <Trans>{Math.round(profileInsights.bpmRange.min)} to {Math.round(profileInsights.bpmRange.max)}</Trans>
                          </div>
                        )}
                      </>
                    ) : (
                      <div className="mt-2 text-sm text-osu-f1">-</div>
                    )}
                  </div>
                  <button
                    type="button"
                    className={`${INSIGHT_CELL_CLASS} group w-full text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-osu-pink/50 ${hasPpDistribution ? INSIGHT_CELL_INTERACTIVE_CLASS : "cursor-default"}`}
                    onClick={hasPpDistribution ? () => setPpModalOpen(true) : undefined}
                    disabled={!hasPpDistribution}
                  >
                    <div className="flex items-center justify-between">
                      <div className={INSIGHT_LABEL_CLASS}>{t`PP Range`}</div>
                      {hasPpDistribution && <ExpandHint />}
                    </div>
                    {profileInsights.ppRange ? (
                      <>
                        <div className="mt-2 flex items-baseline gap-1.5">
                          <span className="text-[26px] font-black leading-none tabular-nums text-osu-pink-light">{Math.round(profileInsights.ppRange.top)}</span>
                          <span className="text-[11px] text-osu-f1">{t`to`}</span>
                          <span className="text-[26px] font-black leading-none tabular-nums text-white">{Math.round(profileInsights.ppRange.bottom)}</span>
                        </div>
                        <div className="mt-auto pt-2.5 text-[11px] text-osu-f1">{t`${Math.round(profileInsights.ppRange.top - profileInsights.ppRange.bottom)}pp spread`}</div>
                      </>
                    ) : (
                      <div className="mt-2 text-sm text-osu-f1">-</div>
                    )}
                  </button>
                </div>

                {/* Row 2: Newest + Oldest top play with map backgrounds */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <TopPlayCard label={t`Newest Top Play`} snapshot={displayedProfileInsights.newestTopPlay} />
                  <TopPlayCard label={t`Oldest Top Play`} snapshot={displayedProfileInsights.oldestTopPlay} />
                </div>
              </div>
              );
            })() : null}
          </div>

          {/* Player tabs */}
          <div className="flex flex-col gap-3 border-t border-osu-b3/25 pt-1 lg:flex-row lg:items-center lg:justify-between">
            <div ref={tabsRailRef} className="-mx-4 overflow-x-auto px-4 scrollbar-hide sm:mx-0 sm:px-0">
              <div className="flex min-w-max">
                {playerTabs.map((playerTab) => (
                  <button
                    key={playerTab}
                    data-player-tab={playerTab}
                    onClick={() => handleTabChange(playerTab)}
                    className={`relative shrink-0 cursor-pointer whitespace-nowrap px-4 py-3 text-[12px] font-semibold transition-colors duration-[120ms] ${tab === playerTab ? "text-white" : "text-osu-f1 hover:text-osu-l2"}`}
                  >
                    {i18n._(getPlayerTabLabelMsg(playerTab))}
                    {tab === playerTab && (
                      <motion.span
                        layoutId="player-tab-indicator"
                        className="absolute inset-x-2.5 bottom-0 h-[2px] rounded-full bg-osu-h1"
                        transition={{ type: "spring", stiffness: 420, damping: 34 }}
                      />
                    )}
                  </button>
                ))}
              </div>
            </div>
            {(tab === "recent" || (tab === "best" && availableKeyModes.length > 1)) && (
              <div className="hidden items-center gap-2 lg:flex">
                {tab === "recent" && (
                  <RecentOsuSourceButton
                    loading={loadingOsuRecent}
                    loaded={recentOsuLoaded}
                    fetchedAt={recentOsuFetchedAt}
                    onFetch={handleFetchOsuRecent}
                  />
                )}
                {availableKeyModes.length > 1 && (
                  <KeyModeControl
                    availableKeyModes={availableKeyModes}
                    keyFilter={keyFilter}
                    onChangeKeyFilter={setKeyFilter}
                  />
                )}
              </div>
            )}
          </div>

          {tab === "best" && bestWindowLoaded && best.length > 0 && (
            <BestScoresControlBar
              availableKeyModes={availableKeyModes}
              keyFilter={keyFilter}
              onChangeKeyFilter={setKeyFilter}
              maxInlineKeyModes={MAX_INLINE_KEY_MODES}
              keyModePlayCounts={keyModePlayCounts}
              onKeyModeOverflow={keyModeOverflowHandler}
              mods={relevantBestMods}
              modFilter={bestModFilter}
              onCycleMod={cycleBestMod}
              onReverseCycleMod={reverseCycleBestMod}
              onClearMods={() => setBestModFilter({})}
              sort={bestSort}
              ppSort={bestPpSort}
              ageSort={bestAgeSort}
              onChangeSort={handleBestSortChange}
            />
          )}
          {/* Wraps before it scrolls: a player with many keymodes gets the strip on
              its own line, where the pills still fit at phone width. */}
          {tab === "recent" && (
            <div className={`mt-3 flex flex-wrap items-center gap-2 lg:hidden ${
              availableKeyModes.length > 1 ? "justify-between" : "justify-end"
            }`}>
              <RecentOsuSourceButton
                loading={loadingOsuRecent}
                loaded={recentOsuLoaded}
                fetchedAt={recentOsuFetchedAt}
                onFetch={handleFetchOsuRecent}
              />
              {availableKeyModes.length > 1 && (
                <KeyModeControl
                  availableKeyModes={availableKeyModes}
                  keyFilter={keyFilter}
                  onChangeKeyFilter={setKeyFilter}
                  maxVisible={MAX_INLINE_KEY_MODES}
                  playCounts={keyModePlayCounts}
                  onOverflow={keyModeOverflowHandler}
                />
              )}
            </div>
          )}
          {tab === "recent" && recentOsuError && (
            <div role="alert" className="mt-2 text-right text-[10px] text-osu-red">
              {recentOsuError}
            </div>
          )}
        </div>
      </div>

      {/* Tab body: About card or scores list */}
      <div className="bg-osu-b5 border-t border-osu-b3/20">
        <div className="max-w-[1200px] mx-auto px-4 sm:px-5 py-5 space-y-1.5">
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
                    <div>{t`No About content found.`}</div>
                    <button
                      type="button"
                      onClick={() => setAboutEditing(true)}
                      className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-osu-b4 text-[12px] font-semibold text-osu-l2 border border-osu-b3/30 hover:bg-osu-b3 transition-colors cursor-pointer"
                    >
                      <Pencil size={13} />
                      {t`Write one in the BBCode editor`}
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
                  precomputedSkills={maniaCardSkills ?? undefined}
                  loading={!bestWindowLoaded}
                  isOwnProfile={!!auth.viewer && !!user && auth.viewer.id === user.id}
                  tierOverride={cardTierPreview}
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
            ) : tab === "skills" ? (
              <motion.div
                key="skills"
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.14 }}
              >
                <PlayerSkillsPanel user={user} />
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
                  visibleRows.map((row: BestListRow, i: number) => {
                    const key = bestListRowKey(row);
                    const position = keymodeListPositions.get(key)
                      ?? (row.kind === "score" && tab === "best" ? bestPositionByIdentity.get(key) ?? i + 1 : i + 1);
                    return row.kind === "score" ? (
                      <ScoreRow
                        key={key}
                        score={row.score}
                        position={position}
                        layout={scoreRowLayout}
                        onOpenDetails={setDetailScore}
                      />
                    ) : (
                      <TrackedScoreRow
                        key={key}
                        play={row.play}
                        position={position}
                        layout={scoreRowLayout}
                        onOpenDetails={openTrackedPlayDetails}
                      />
                    );
                  })
                ) : (
                  <div className="text-center py-8 text-osu-f1 text-sm">
                    {tab === "recent" ? t`No tracked plays found` : t`No scores found`}
                  </div>
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
                {isLoadingMoreCurrentTab ? t`Loading...` : t`Show more`}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function TungTungSahurKeycap() {
  const { t } = useLingui();
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
      aria-label={t`Tung tung sahur keycap`}
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
  const playerTabs = PLAYER_TABS;
  const { i18n } = useLingui();
  return (
    <div className="flex-1 bg-osu-b5">
      <div className="relative overflow-hidden bg-osu-b4">
        <div className="absolute inset-0 bg-gradient-to-b from-osu-d5 to-osu-b5" />
        <div className="relative mx-auto max-w-[1200px] px-4 pt-8 pb-7 sm:px-5 sm:pt-12 sm:pb-9">
          <div className="flex items-center gap-4 sm:gap-5">
            <Skeleton className="h-[84px] w-[84px] flex-shrink-0 rounded-2xl sm:h-[124px] sm:w-[124px]" />
            <div className="min-w-0 flex-1 space-y-3">
              <Skeleton className="h-7 w-40 sm:h-10 sm:w-64" />
              <Skeleton className="h-3 w-52" />
            </div>
          </div>
          <div className="mt-7 grid grid-cols-2 gap-x-6 gap-y-5 sm:mt-9 sm:flex sm:flex-wrap sm:gap-x-12">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i}>
                <Skeleton className="h-2.5 w-16" />
                <Skeleton className="mt-2 h-7 w-28 sm:h-9 sm:w-32" />
                <Skeleton className="mt-2 h-2.5 w-20" />
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-[1200px] px-4 sm:px-5">
        <div className="flex flex-wrap items-center gap-x-8 gap-y-5 border-b border-osu-b3/25 py-5 sm:gap-x-12">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i}>
              <Skeleton className="h-2.5 w-16" />
              <Skeleton className="mt-2 h-5 w-20" />
            </div>
          ))}
          <div className="flex items-center gap-4 sm:ml-auto">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-6 w-12" />
            ))}
          </div>
        </div>

        <div className="py-5">
          <InsightsSkeleton />
        </div>

        <div className="border-t border-osu-b3/25 pt-1">
          <div className="-mx-4 overflow-x-auto px-4 scrollbar-hide sm:mx-0 sm:px-0">
            <div className="flex min-w-max">
              {playerTabs.map((playerTab) => (
                <button
                  key={playerTab}
                  onClick={() => onTabChange(playerTab)}
                  className={`relative shrink-0 cursor-pointer whitespace-nowrap px-4 py-3 text-[12px] font-semibold transition-colors duration-[120ms] ${tab === playerTab ? "text-white" : "text-osu-f1 hover:text-osu-l2"}`}
                >
                  {i18n._(getPlayerTabLabelMsg(playerTab))}
                  {tab === playerTab && <span className="absolute inset-x-2.5 bottom-0 h-[2px] rounded-full bg-osu-h1" />}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="space-y-1.5 border-t border-osu-b3/20 py-5">
          {Array.from({ length: 6 }).map((_, i) => (
            <ScoreRowSkeleton key={i} />
          ))}
        </div>
      </div>
    </div>
  );
}

// Empty state for the Activity tab when a player isn't tracked yet. For the signed-in owner it
// becomes an opt-in: they can add themselves to their country's roster instead of being locked
// out for not being in the top 100. Anonymous visitors get a login nudge; other people's
// untracked profiles keep the plain explanation (you can only ever add yourself).
function ActivityOptInEmptyState({
  mode,
  loginAvailable,
  onTracked,
}: {
  mode: "self" | "other" | "anon";
  loginAvailable: boolean;
  onTracked?: () => void;
}) {
  const location = useLocation();
  const { t } = useLingui();
  const [status, setStatus] = useState<"idle" | "pending" | "done" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);
  const loginHref = `/api/auth/osu?next=${encodeURIComponent(`${location.pathname}${location.searchStr}`)}`;

  const handleTrack = useCallback(async () => {
    setStatus("pending");
    setMessage(null);
    try {
      const result = await addSelfToRoster();
      if (result.ok) {
        setStatus("done");
        showTrackingStartedToast();
        onTracked?.();
        return;
      }
      setStatus("error");
      setMessage(
        result.status === "country_not_tracked"
          ? t`Your country isn't tracked yet, so there's nothing to record your plays against.`
          : result.status === "country_full"
            ? t`This country's opt-in list is full right now. Check back later.`
            : t`Couldn't turn on tracking right now. Try again in a moment.`,
      );
    } catch {
      setStatus("error");
      setMessage(t`Couldn't turn on tracking right now. Try again in a moment.`);
    }
  }, [onTracked]);

  if (mode === "self" && status === "done") {
    return (
      <div className="rounded-xl border border-osu-b3/20 bg-osu-b4 p-6 text-center">
        <div className="text-sm font-semibold text-osu-l2">{t`You're being tracked now`}</div>
        <div className="mt-1.5 text-[13px] text-osu-f1">
          {t`Your recent plays are being pulled in. Activity will start filling in here within a minute or two, and keeps updating as you play.`}
        </div>
      </div>
    );
  }

  if (mode === "self") {
    return (
      <div className="rounded-xl border border-osu-b3/20 bg-osu-b4 p-6 text-center">
        <div className="text-sm font-semibold text-osu-l2">{t`Start tracking your plays`}</div>
        <div className="mt-1.5 text-[13px] text-osu-f1">
          {t`Activity is recorded automatically for the top 100 of each country. You're not in it yet, but you can add yourself to the tracker.`}
        </div>
        <button
          type="button"
          onClick={handleTrack}
          disabled={status === "pending"}
          className="mt-4 inline-flex items-center gap-1.5 px-4 py-2 rounded-lg border border-osu-pink/40 bg-osu-pink/15 text-[12px] font-semibold text-osu-pink-light transition-colors hover:bg-osu-pink/25 hover:text-white cursor-pointer disabled:opacity-60 disabled:cursor-default"
        >
          {status === "pending" ? t`Adding you…` : t`Track my plays`}
        </button>
        {message ? <div className="mt-3 text-[12px] text-osu-f1">{message}</div> : null}
      </div>
    );
  }

  if (mode === "anon") {
    return (
      <div className="rounded-xl border border-osu-b3/20 bg-osu-b4 p-6 text-center">
        <div className="text-sm font-semibold text-osu-l2">{t`No activity data for this player`}</div>
        <div className="mt-1.5 text-[13px] text-osu-f1">
          {t`Activity is recorded for the top 100 of each tracked country. If this is your profile, log in with osu! to add yourself to the tracker.`}
        </div>
        {loginAvailable ? (
          <a
            href={loginHref}
            className="mt-4 inline-flex items-center gap-2 rounded-lg border border-osu-pink/40 bg-osu-pink/15 px-4 py-2 text-[12px] font-semibold text-osu-pink-light transition-colors hover:bg-osu-pink/25 hover:text-white"
          >
            <OsuLogo className="h-4 w-4" />
            {t`Log in with osu!`}
          </a>
        ) : null}
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-osu-b3/20 bg-osu-b4 p-6 text-center">
      <div className="text-sm font-semibold text-osu-l2">{t`No activity data for this player`}</div>
      <div className="mt-1.5 text-[13px] text-osu-f1">
        {t`Plays are only recorded for the top 100 players of each tracked country, and this player isn't currently among them.`}
      </div>
    </div>
  );
}

function PlayerSkillCard({ title, accent, children }: { title: string; accent: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-osu-b3/20 bg-osu-b4 p-4">
      <div className="mb-3 flex items-center gap-2">
        <span className="h-3.5 w-1 rounded-full" style={{ backgroundColor: accent }} />
        <span className="text-[11px] font-semibold uppercase tracking-wide text-osu-l3">{title}</span>
      </div>
      {children}
    </div>
  );
}

// Public Skills tab: the exact per-keymode skill ratings (same renderer as the
// My Data card) with population percentiles and player dan chips. First-time
// visitors start "pending" while the backend rates their plays, so the panel
// polls until the breakdown lands.
function PlayerSkillsPanel({ user }: { user: OsuUser }) {
  const { t } = useLingui();
  const [skills, setSkills] = useState<LivePlayerSkills | null>(null);
  const [skillsError, setSkillsError] = useState(false);
  const [selectedSkill, setSelectedSkill] = useState<{ entry: SkillAxisEntry; keyCount: number } | null>(null);
  const [selectedDan, setSelectedDan] = useState<{ side: "rc" | "ln"; keyCount: number } | null>(null);
  const liveConfigured = isLiveBackendConfigured();

  useEffect(() => {
    if (!liveConfigured) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let attempts = 0;
    const load = async () => {
      try {
        const data = await fetchLivePlayerSkillsDirect(user.id);
        if (cancelled) return;
        setSkills(data);
        setSkillsError(false);
        if (data.status === "pending" && attempts < 40) {
          // Fast polls while the compute is imminent, then back off; deploy-day
          // version bumps can park a profile deep in the analyzer queue.
          attempts += 1;
          timer = setTimeout(() => void load(), attempts <= 12 ? 6_000 : 15_000);
        }
      } catch {
        if (!cancelled) setSkillsError(true);
      }
    };
    void load();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [user.id, liveConfigured]);

  useEffect(() => {
    setSelectedSkill(null);
  }, [user.id]);

  if (!liveConfigured) {
    return <div className="py-8 text-center text-sm text-osu-f1">{t`Skill ratings are unavailable right now.`}</div>;
  }
  if (skillsError) {
    return <div className="py-8 text-center text-sm text-osu-f1">{t`Could not load skill ratings. Try again in a bit.`}</div>;
  }
  if (!skills) {
    return (
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {Array.from({ length: 2 }).map((_, i) => (
          <div key={i} className="space-y-3 rounded-xl border border-osu-b3/20 bg-osu-b4 p-4">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-7 w-24" />
            {Array.from({ length: 5 }).map((_, j) => (
              <Skeleton key={j} className="h-3 w-full" />
            ))}
          </div>
        ))}
      </div>
    );
  }

  const modes = qualifyingSkillModes(skills);
  if (skills.status !== "ready" || modes.length === 0) {
    return (
      <div className="mx-auto max-w-[440px]">
        <PlayerSkillCard title={t`Skill rating`} accent={skillRatingAccent(null)}>
          <SkillBreakdownBody skills={skills} mode={null} />
        </PlayerSkillCard>
      </div>
    );
  }
  return (
    <>
      <div
        className={`grid grid-cols-1 gap-3 ${
          modes.length > 1
            ? "xl:grid-cols-2 xl:[&>*:last-child:nth-child(odd)]:col-span-2"
            : "md:max-w-[640px]"
        }`}
      >
        {modes.map((mode) => (
          <SkillModePanel
            key={mode.keyCount}
            skills={skills}
            mode={mode}
            onSelectEntry={(entry) => setSelectedSkill({ entry, keyCount: mode.keyCount })}
            onSelectDan={(side) => setSelectedDan({ side, keyCount: mode.keyCount })}
          />
        ))}
      </div>
      {selectedSkill ? (
        <SkillPlaysModal
          userId={user.id}
          username={user.username}
          keyCount={selectedSkill.keyCount}
          axis={selectedSkill.entry.axis}
          label={selectedSkill.entry.label}
          color={selectedSkill.entry.color}
          onClose={() => setSelectedSkill(null)}
        />
      ) : null}
      {selectedDan ? (
        <DanEvidenceModal
          userId={user.id}
          username={user.username}
          keyCount={selectedDan.keyCount}
          side={selectedDan.side}
          onClose={() => setSelectedDan(null)}
        />
      ) : null}
    </>
  );
}

function PlayerActivityPanel({ user }: { user: OsuUser }) {
  const auth = useAuth();
  const { t, i18n } = useLingui();
  const currentYear = new Date().getFullYear();
  const [selectedYear, setSelectedYear] = useState(currentYear);
  const [activityRefreshKey, setActivityRefreshKey] = useState(0);
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
  const modalPlayedLabel = modalDay ? formatActivityDuration(getActivityDayPlayedMs(modalDay)) : null;
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
      setError(t`Activity is only available when the server is configured.`);
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
        setError(t`Couldn't load Activity right now.`);
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [activityRefreshKey, selectedYear, user.id]);

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
        setDayDetailError(t`Couldn't load the full day detail.`);
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
    const optInMode: "self" | "other" | "anon" =
      auth.viewer == null ? "anon" : auth.viewer.id === user.id ? "self" : "other";
    return (
      <ActivityOptInEmptyState
        mode={optInMode}
        loginAvailable={auth.loginAvailable}
        onTracked={() => setActivityRefreshKey((key) => key + 1)}
      />
    );
  }

  return (
    <>
      <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_130px]">
        <section className="min-w-0 px-1 py-2 sm:px-0">
          <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
            <div>
              <h2 className="text-xl font-semibold text-white">
                <Trans>{formatNumber(activity.totalScores)} plays in {selectedYear}</Trans>
              </h2>
            </div>
            <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
              <ActivityInlineMetric label={t`Avg active day`} value={formatNumber(averageActiveDay)} detail={t`plays`} />
              <ActivityInlineMetric label={t`Streak`} value={t`${activity.currentStreak}d`} detail={t`now`} />
            </div>
          </div>

          <div className="mt-6 sm:mt-7">
            <div className="flex gap-2">
              {/* Row pitch must match the cells: fixed 12px rows on mobile (cells are
                  12px), 1fr rows on sm+ where pt-5 equals the month-label row (h-3 +
                  mt-2) so the stretched height equals the heatmap grid exactly. */}
              <div className="grid w-8 shrink-0 grid-rows-[repeat(7,12px)] gap-1 pt-5 text-[10px] leading-none text-osu-f1 sm:grid-rows-7">
                {ACTIVITY_WEEKDAY_LABELS.map((day, index) => (
                  <span key={index} className="flex items-center">{i18n._(day)}</span>
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
                                title={t`${formatFullActivityDate(day.date)}: ${day.scoreCount} plays, ${day.sessionCount} sessions`}
                                onClick={() => setSelectedDay(day)}
                                className="aspect-square w-full min-w-0 rounded-[3px] border transition-transform hover:scale-125 hover:ring-2 hover:ring-osu-pink/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-osu-pink/90"
                                style={getActivityCellStyle(day, activity.typicalSession)}
                              />
                            ) : (
                              <span
                                key={day.date}
                                title={t`${formatFullActivityDate(day.date)}: no tracked plays`}
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
              <Trans>Typical session <span className="font-semibold text-osu-l2">{activity.typicalSession} plays</span></Trans>
            </span>
            {import.meta.env.DEV && (
              <button
                type="button"
                onClick={() => setDevDay(createDevActivityDay(activity.timezone))}
                className="rounded-lg border border-osu-pink/25 bg-osu-pink/10 px-2 py-1 text-[10px] font-semibold text-osu-pink-light transition-colors hover:bg-osu-pink/20"
                title={t`Open the day modal with simulated busy-day data`}
              >
                {t`Sim busy day`}
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
                  <div className="text-[9px] font-black uppercase tracking-wide text-osu-pink-light sm:text-[10px]">{t`Activity day`}</div>
                  <h3 className="mt-1 text-xl font-black text-white sm:text-2xl">{formatFullActivityDate(modalDay.date)}</h3>
                </div>
                <button
                  type="button"
                  onClick={closeDayModal}
                  aria-label={t`Close activity details`}
                  className="flex h-8 w-8 items-center justify-center rounded-full text-osu-f1 hover:bg-osu-b3/50 hover:text-white"
                >
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <path d="M1 1l12 12M13 1L1 13" />
                  </svg>
                </button>
              </div>

              <div className="min-h-0 overflow-y-auto pr-1 [scrollbar-gutter:stable]">
                <div className={`mt-4 grid gap-2 sm:mt-5 ${modalPlayedLabel ? "grid-cols-2 sm:grid-cols-4" : "grid-cols-3"}`}>
                  <ActivityDetailMetric label={t`Plays`} value={formatNumber(modalDay.scoreCount)} />
                  <ActivityDetailMetric label={t`Sessions`} value={formatNumber(modalDay.sessionCount)} />
                  {modalPlayedLabel ? <ActivityDetailMetric label={t`Time played`} value={modalPlayedLabel} /> : null}
                  <ActivityDetailMetric label={t`Maps`} value={formatNumber(modalDay.mapCount)} />
                </div>

                <ActivitySessionFlow day={modalDay} timezone={activity.timezone} />

                <ActivityDayMaps
                  key={modalDay.date}
                  maps={modalDay.maps}
                  mapCount={modalDay.mapCount}
                  loading={dayDetailLoading}
                  error={dayDetailError}
                />

                <div className="mt-4 rounded-lg border border-osu-b3/20 bg-osu-b5/35 p-3 sm:mt-5 sm:p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-[11px] font-bold uppercase text-osu-f1 sm:text-xs">{t`Pattern mix`}</div>
                    <div className="text-[10px] text-osu-f1 sm:text-[11px]">{t`avg intensity, 0-100`}</div>
                  </div>
                  {modalDay.skills && modalDay.skills.analyzedPlays > 0 ? (
                    <ActivityPatternMix key={modalDay.date} skills={modalDay.skills} />
                  ) : dayDetailLoading ? (
                    <div className="mt-3 space-y-2">
                      <Skeleton className="h-3 rounded-full" />
                      <Skeleton className="h-3 rounded-full" />
                      <Skeleton className="h-3 rounded-full" />
                      <Skeleton className="h-3 rounded-full" />
                    </div>
                  ) : (
                    <div className="mt-3 text-[11px] text-osu-f1">
                      {t`Skill analysis is queued for the maps played on this day.`}
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
  const { t, i18n } = useLingui();
  const [selectedKeyModeIndex, setSelectedKeyModeIndex] = useState(0);
  const activeIndex = Math.min(selectedKeyModeIndex, keyModes.length - 1);
  const activeKeyMode = keyModes[activeIndex];
  const entries = getActivityPatternEntries(activeKeyMode.patterns, activeKeyMode.keyCount, i18n).slice(0, 6);
  return (
    <div className="mt-3">
      {keyModes.length > 1 && (
        <div className="mb-3 flex flex-wrap gap-1">
          {keyModes.map((keyMode, index) => {
            const selected = index === activeIndex;
            return (
              <button
                key={`${keyMode.keyCount ?? "unknown"}:${index}`}
                type="button"
                onClick={() => setSelectedKeyModeIndex(index)}
                className={`rounded-md px-2.5 py-1 text-[11px] font-bold transition-colors ${selected
                    ? "bg-osu-pink text-white"
                    : "bg-osu-b4/60 text-osu-f1 hover:bg-osu-b3/55 hover:text-osu-l2"
                  }`}
              >
                {formatActivityKeyCount(keyMode.keyCount) ?? t`Other`}
                <span className={`ml-1 font-semibold ${selected ? "text-white/75" : "text-osu-f1/80"}`}>
                  <Plural value={keyMode.analyzedPlays} one={`${formatNumber(keyMode.analyzedPlays)} play`} other={`${formatNumber(keyMode.analyzedPlays)} plays`} />
                </span>
              </button>
            );
          })}
        </div>
      )}
      {entries.length > 0 ? (
        <div className="space-y-2.5">
          {entries.map(({ key, label, value }) => (
            <div key={key}>
              <div className="mb-1 flex items-baseline justify-between gap-3">
                <span className="flex items-center gap-1.5 text-xs font-semibold text-osu-l2">
                  <span className="h-2 w-2 shrink-0 rounded-[2px]" style={{ backgroundColor: getActivitySkillColor(key) }} />
                  {label}
                </span>
                <span className="text-xs font-black text-white">{value}</span>
              </div>
              <div className="h-2 rounded-full bg-osu-b3/35">
                <div
                  className="h-full rounded-full"
                  style={{ width: `${value}%`, backgroundColor: getActivitySkillColor(key) }}
                />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="text-[11px] text-osu-f1">{t`No pattern signal for this keymode yet.`}</div>
      )}
      {activeKeyMode.analyzedPlays < activeKeyMode.totalPlays && (
        <div className="mt-2 text-[10px] text-osu-f1">
          <Trans>{formatNumber(activeKeyMode.analyzedPlays)} of {formatNumber(activeKeyMode.totalPlays)} plays analyzed</Trans>
        </div>
      )}
    </div>
  );
}

function ActivitySessionFlow({ day, timezone }: { day: ActivityDay; timezone: string }) {
  const { t, i18n } = useLingui();
  if (day.timeline.length === 0) return null;
  const sessions = groupActivityTimelineBySession(day.timeline).map(mergeActivitySessionSegments);
  const flowLabel = formatActivityKeyFlow(day.timeline, t`mixed keys`);
  const timezoneHint = getActivityTimezoneHint(timezone, day.timeline[0]?.startAt);
  const multiKeymode = new Set(day.timeline.map((segment) => segment.keyCount ?? 0)).size > 1;
  return (
    <div className="mt-4 rounded-lg border border-osu-b3/20 bg-osu-b5/35 p-3 sm:mt-5 sm:p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="text-[11px] font-bold uppercase text-osu-f1 sm:text-xs">
          {t`Sessions`}
          {timezoneHint ? <span className="ml-1.5 font-semibold normal-case text-osu-f1/70">{timezoneHint}</span> : null}
        </div>
        <div className="text-[10px] font-semibold text-osu-l2 sm:text-[11px]">{flowLabel}</div>
      </div>
      <ActivityDayClock sessions={sessions} timezone={timezone} dayKey={day.date} />
      <div className="mt-4 space-y-3.5">
        {sessions.map((session, sessionIndex) => {
          const sessionPlays = session.reduce((sum, segment) => sum + segment.playCount, 0);
          const first = session[0];
          const last = session[session.length - 1];
          const startDateLabel = formatActivitySessionDate(first.startAt, day.date, timezone);
          const elapsed = Date.parse(last.endAt) - Date.parse(first.startAt);
          const durationLabel = formatActivityDuration(Number.isFinite(elapsed) ? elapsed : 0);
          const breakdown = aggregateActivitySessionBreakdown(session);
          return (
            <div key={first.key}>
              <div className="mb-1.5 flex items-baseline justify-between gap-3">
                <span className="text-[11px] font-semibold text-osu-l2">
                  {sessions.length > 1 ? <span className="text-osu-f1"><Trans>Session {sessionIndex + 1}</Trans> · </span> : null}
                  {startDateLabel ? `${startDateLabel} · ` : null}
                  {formatActivityTime(first.startAt, timezone)} - {formatActivityTime(last.endAt, timezone)}
                  {durationLabel ? <span className="font-normal text-osu-f1"> · {durationLabel}</span> : null}
                </span>
                <span className="text-[10px] text-osu-f1">
                  <Plural value={sessionPlays} one={`${formatNumber(sessionPlays)} play`} other={`${formatNumber(sessionPlays)} plays`} />
                </span>
              </div>
              <div className="flex h-2.5 overflow-hidden rounded-full bg-osu-b4/70">
                {session.map((segment) => (
                  <div
                    key={segment.key}
                    title={formatActivitySegmentTitle(segment, timezone, i18n)}
                    className="min-w-0 border-r border-black/25 last:border-r-0"
                    style={{
                      flexBasis: 0,
                      flexGrow: Math.max(1, segment.playCount),
                      backgroundColor: getActivityTimelineSegmentColor(segment),
                    }}
                  />
                ))}
              </div>
              <div className="mt-1.5 flex flex-wrap gap-1">
                {breakdown.map((entry) => {
                  const known = entry.skill !== "unknown";
                  const label = known ? getActivitySkillLabel(entry.skill, entry.keyCount, i18n) : t`Unanalyzed`;
                  const keyLabel = multiKeymode ? formatActivityKeyCount(entry.keyCount) : null;
                  return (
                    <span
                      key={`${entry.skill}:${entry.keyCount ?? "x"}`}
                      title={entry.playCount === 1 ? t`${formatNumber(entry.playCount)} play` : t`${formatNumber(entry.playCount)} plays`}
                      className="flex items-center gap-1 rounded bg-osu-b4/60 px-1.5 py-1 text-[10px] leading-none"
                    >
                      <span
                        className="h-1.5 w-1.5 shrink-0 rounded-[2px]"
                        style={{ backgroundColor: getActivitySkillColor(entry.skill) }}
                      />
                      <span className={`font-semibold ${known ? "text-osu-l2" : "text-osu-f1"}`}>
                        {label}
                        {keyLabel ? ` ${keyLabel}` : null}
                      </span>
                      {entry.playCount > 1 ? <span className="text-osu-f1">×{formatNumber(entry.playCount)}</span> : null}
                    </span>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Marks where each session sits in the player's local day so "played in the
// evening" is visible without reading the time labels. Sessions bleeding past
// the day boundary (stale pre-timezone data) clamp to the day's edges.
function ActivityDayClock({ sessions, timezone, dayKey }: {
  sessions: ActivityTimelineSegment[][];
  timezone: string;
  dayKey: string;
}) {
  const { t } = useLingui();
  const blocks = sessions
    .map((session) => {
      const first = session[0];
      const last = session[session.length - 1];
      const startKey = getZonedDateKey(new Date(first.startAt), timezone);
      const endKey = getZonedDateKey(new Date(last.endAt), timezone);
      const startMin = startKey === dayKey
        ? getZonedMinutesOfDay(first.startAt, timezone)
        : startKey < dayKey ? 0 : null;
      const endMin = endKey === dayKey
        ? getZonedMinutesOfDay(last.endAt, timezone)
        : endKey > dayKey ? ACTIVITY_MINUTES_PER_DAY : null;
      if (startMin == null || endMin == null) return null;
      let end = Math.max(startMin, endMin);
      let start = startMin;
      if (end - start < ACTIVITY_DAY_CLOCK_MIN_MINUTES) {
        end = Math.min(ACTIVITY_MINUTES_PER_DAY, start + ACTIVITY_DAY_CLOCK_MIN_MINUTES);
        start = end - ACTIVITY_DAY_CLOCK_MIN_MINUTES;
      }
      const plays = session.reduce((sum, segment) => sum + segment.playCount, 0);
      return {
        key: first.key,
        left: (start / ACTIVITY_MINUTES_PER_DAY) * 100,
        width: ((end - start) / ACTIVITY_MINUTES_PER_DAY) * 100,
        title: plays === 1
          ? t`${formatActivityTime(first.startAt, timezone)} - ${formatActivityTime(last.endAt, timezone)} · ${formatNumber(plays)} play`
          : t`${formatActivityTime(first.startAt, timezone)} - ${formatActivityTime(last.endAt, timezone)} · ${formatNumber(plays)} plays`,
      };
    })
    .filter((block): block is NonNullable<typeof block> => block != null);
  if (blocks.length === 0) return null;
  return (
    <div className="mt-3">
      <div className="relative h-2 rounded-full bg-osu-b4/70">
        {[25, 50, 75].map((percent) => (
          <span key={percent} className="absolute inset-y-0 w-px bg-osu-b3/40" style={{ left: `${percent}%` }} />
        ))}
        {blocks.map((block) => (
          <span
            key={block.key}
            title={block.title}
            className="absolute inset-y-0 rounded-full bg-osu-pink"
            style={{ left: `${block.left}%`, width: `${block.width}%` }}
          />
        ))}
      </div>
      <div className="mt-1 flex justify-between text-[9px] leading-none text-osu-f1">
        <span>{t`12 AM`}</span>
        <span>{t`6 AM`}</span>
        <span>{t`12 PM`}</span>
        <span>{t`6 PM`}</span>
        <span>{t`12 AM`}</span>
      </div>
    </div>
  );
}

// Below this the list renders in full; above it the tail collapses behind an
// inline "show more" so the modal has a single scrollbar instead of a nested one.
const ACTIVITY_DAY_MAPS_PREVIEW = 6;

function ActivityDayMaps({ maps, mapCount, loading, error }: {
  maps: ActivityPlayedMap[];
  mapCount: number;
  loading: boolean;
  error: string | null;
}) {
  const { t } = useLingui();
  const [expanded, setExpanded] = useState(false);
  const visibleMaps = expanded ? maps : maps.slice(0, ACTIVITY_DAY_MAPS_PREVIEW);
  const hiddenCount = maps.length - visibleMaps.length;
  return (
    <div className="mt-4 rounded-lg border border-osu-b3/20 bg-osu-b5/35 p-3 sm:mt-5 sm:p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="text-[11px] font-bold uppercase text-osu-f1 sm:text-xs">{t`Maps played`}</div>
        <div className="text-[10px] text-osu-f1 sm:text-[11px]">
          {loading
            ? t`loading`
            : mapCount > maps.length
              ? t`${maps.length} of ${mapCount}`
              : maps.length === 1
                ? t`${maps.length} map`
                : t`${maps.length} maps`}
        </div>
      </div>
      <div className="mt-2 space-y-1.5 sm:mt-3 sm:space-y-2">
        {loading && maps.length === 0 ? (
          <>
            <Skeleton className="h-16 rounded-md" />
            <Skeleton className="h-16 rounded-md" />
            <Skeleton className="h-16 rounded-md" />
          </>
        ) : (
          visibleMaps.map((map) => (
            <ActivityMapRow key={map.key} map={map} />
          ))
        )}
        {error ? (
          <div className="rounded-md bg-osu-b4/70 px-3 py-2 text-[11px] text-osu-f1">
            {error}
          </div>
        ) : null}
      </div>
      {hiddenCount > 0 ? (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="mt-2 w-full rounded-md bg-osu-b4/60 px-3 py-1.5 text-[11px] font-semibold text-osu-f1 transition-colors hover:bg-osu-b3/50 hover:text-osu-l2"
        >
          <Plural value={hiddenCount} one="Show # more map" other="Show # more maps" />
        </button>
      ) : expanded ? (
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className="mt-2 w-full rounded-md bg-osu-b4/60 px-3 py-1.5 text-[11px] font-semibold text-osu-f1 transition-colors hover:bg-osu-b3/50 hover:text-osu-l2"
        >
          {t`Show fewer`}
        </button>
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
        <ActivityMapPatternTag skills={map.skills} keyCount={map.keyCount} />
      </div>
      <div className="text-right">
        <div className="text-[13px] font-black text-osu-l2 sm:text-sm">{formatNumber(map.plays)}</div>
        <div className="text-[10px] text-osu-f1"><Plural value={map.plays} one="play" other="plays" /></div>
      </div>
    </a>
  );
}

// One clear primary-pattern tag instead of a row of abbreviated score pills;
// the full breakdown stays reachable via the tooltip.
function ActivityMapPatternTag({ skills, keyCount }: { skills: LivePlayerActivitySkillVector | null; keyCount: number | null }) {
  const { i18n } = useLingui();
  if (!skills) return null;
  const primary = getActivityPrimarySkill(skills);
  if (primary === "unknown") return null;
  const entries = getActivityPatternEntries(skills.patterns, keyCount, i18n);
  const secondary = entries.filter(({ key }) => key !== primary).slice(0, 2);
  const tooltip = entries.slice(0, 5).map(({ label, value }) => `${label} ${value}`).join(" · ");
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1.5" title={tooltip}>
      <span
        className="rounded px-1.5 py-0.5 text-[9px] font-black leading-none text-white"
        style={{ backgroundColor: primary === "mixed" ? "rgba(255,255,255,0.14)" : getActivitySkillColor(primary) }}
      >
        {getActivitySkillLabel(primary, keyCount, i18n)}
      </span>
      {secondary.length > 0 ? (
        <span className="text-[9px] leading-none text-osu-f1">
          + {secondary.map(({ label }) => label).join(", ")}
        </span>
      ) : null}
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

// Time actually spent inside sessions (first to last play of each one), not
// the wall-clock span of the day.
function getActivityDayPlayedMs(day: ActivityDay): number {
  return groupActivityTimelineBySession(day.timeline).reduce((sum, session) => {
    const elapsed = Date.parse(session[session.length - 1].endAt) - Date.parse(session[0].startAt);
    return sum + Math.max(0, Number.isFinite(elapsed) ? elapsed : 0);
  }, 0);
}

// One entry per skill+keymode with summed plays: the session bar already
// carries the chronology, so the chip list reads as "what was played",
// most-played first, instead of one chip per timeline segment.
function aggregateActivitySessionBreakdown(session: ActivityTimelineSegment[]): {
  skill: LivePlayerActivityPrimarySkill;
  keyCount: number | null;
  playCount: number;
}[] {
  const groups = new Map<string, { skill: LivePlayerActivityPrimarySkill; keyCount: number | null; playCount: number }>();
  for (const segment of session) {
    const key = `${segment.primarySkill}:${segment.keyCount ?? "x"}`;
    const existing = groups.get(key);
    if (existing) {
      existing.playCount += segment.playCount;
    } else {
      groups.set(key, { skill: segment.primarySkill, keyCount: segment.keyCount, playCount: segment.playCount });
    }
  }
  return [...groups.values()].sort((left, right) => right.playCount - left.playCount);
}

function getActivityPrimarySkill(skills: LivePlayerActivitySkillVector | null): LivePlayerActivityPrimarySkill {
  return skills?.primary ?? "unknown";
}

// Pattern ids come from the backend's dan estimator families; unknown ids get
// a derived label and a palette color so future families render unchanged.
const ACTIVITY_PATTERN_META: Record<string, { label: MessageDescriptor; shortLabel: string; color: string }> = {
  stream: { label: msg`Stream`, shortLabel: "S", color: "#8f6bd8" },
  jumpstream: { label: msg`Jumpstream`, shortLabel: "JS", color: "#6f87d8" },
  handstream: { label: msg`Handstream`, shortLabel: "HS", color: "#b06bc0" },
  jack: { label: msg`Jack`, shortLabel: "J", color: "#c66f84" },
  chordjack: { label: msg`Chordjack`, shortLabel: "CJ", color: "#c59a5c" },
  stamina: { label: msg`Stamina`, shortLabel: "ST", color: "#ad6b5d" },
  tech: { label: msg`Tech`, shortLabel: "T", color: "#83a86f" },
  ln: { label: msg`LN`, shortLabel: "LN", color: "#57aeba" },
  lnGeneral: { label: msg`LN General`, shortLabel: "LNG", color: "#63bf98" },
  lnRelease: { label: msg`LN Release`, shortLabel: "LNR", color: "#58b7d9" },
  lnInverse: { label: msg`LN Inverse`, shortLabel: "LNI", color: "#7fbed2" },
  lnTech: { label: msg`LN Tech`, shortLabel: "LNT", color: "#9f78df" },
  unknown: { label: msg`Unknown`, shortLabel: "", color: "#5f596b" },
};

const ACTIVITY_WEEKDAY_LABELS: MessageDescriptor[] = [
  msg`Sun`,
  msg`Mon`,
  msg`Tue`,
  msg`Wed`,
  msg`Thu`,
  msg`Fri`,
  msg`Sat`,
];

const ACTIVITY_PATTERN_FALLBACK_COLORS = ["#8c7fb8", "#b88a7f", "#7fb89a", "#b8a87f", "#7f9ab8"];

function getActivityPatternColor(patternId: string): string {
  const meta = ACTIVITY_PATTERN_META[patternId];
  if (meta) return meta.color;
  let hash = 0;
  for (let index = 0; index < patternId.length; index++) hash = (hash * 31 + patternId.charCodeAt(index)) | 0;
  return ACTIVITY_PATTERN_FALLBACK_COLORS[Math.abs(hash) % ACTIVITY_PATTERN_FALLBACK_COLORS.length];
}

function getActivityPatternMeta(patternId: string, keyCount: number | null, i18n: I18n): { label: string; shortLabel: string; color: string } {
  // The estimator's handstream family reads as brackets in 7K+ vocabulary;
  // the score is the same, only the label follows the keymode.
  if (patternId === "handstream" && keyCount != null && keyCount >= 7) {
    return { label: i18n._(msg`Bracket`), shortLabel: "B", color: ACTIVITY_PATTERN_META.handstream.color };
  }
  const meta = ACTIVITY_PATTERN_META[patternId];
  if (meta) return { label: i18n._(meta.label), shortLabel: meta.shortLabel, color: meta.color };
  return {
    label: patternId.charAt(0).toUpperCase() + patternId.slice(1),
    shortLabel: patternId.slice(0, 2).toUpperCase(),
    color: getActivityPatternColor(patternId),
  };
}

function getActivityPatternEntries(patterns: LivePlayerActivityPatterns | null | undefined, keyCount: number | null, i18n: I18n) {
  return Object.entries(patterns ?? {})
    .map(([key, raw]) => {
      const meta = getActivityPatternMeta(key, keyCount, i18n);
      return { key, label: meta.label, shortLabel: meta.shortLabel, value: Math.round(clamp01(Number(raw)) * 100) };
    })
    .filter(({ value }) => value >= 5)
    .sort((left, right) => right.value - left.value);
}

function getActivitySkillColor(skill: LivePlayerActivityPrimarySkill): string {
  return getActivityPatternColor(skill);
}

function getActivityTimelineSegmentColor(segment: ActivityTimelineSegment): string {
  return getActivitySkillColor(segment.primarySkill);
}

function getActivitySkillLabel(skill: LivePlayerActivityPrimarySkill, keyCount: number | null, i18n: I18n): string {
  if (skill === "mixed") return i18n._(msg`Hybrid`);
  return getActivityPatternMeta(skill, keyCount, i18n).label;
}

function formatActivityKeyFlow(segments: ActivityTimelineSegment[], mixedLabel: string): string {
  const labels = [...new Set(segments
    .map((segment) => formatActivityKeyCount(segment.keyCount))
    .filter((label): label is string => label != null))];
  if (labels.length === 0) return mixedLabel;
  return labels.join(" / ");
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

function formatActivitySegmentTitle(segment: ActivityTimelineSegment, timeZone: string, i18n: I18n): string {
  const scores = getActivityPatternEntries(segment.patterns, segment.keyCount, i18n)
    .slice(0, 4)
    .map(({ shortLabel, value }) => `${shortLabel} ${value}%`)
    .join(" / ");
  return [
    `${formatActivityTime(segment.startAt, timeZone)} - ${formatActivityTime(segment.endAt, timeZone)}`,
    segment.playCount === 1
      ? i18n._(msg`${formatNumber(segment.playCount)} play`)
      : i18n._(msg`${formatNumber(segment.playCount)} plays`),
    formatActivityKeyCount(segment.keyCount),
    getActivitySkillLabel(segment.primarySkill, segment.keyCount, i18n),
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

const ACTIVITY_MINUTES_PER_DAY = 24 * 60;
// Below this a session block on the day clock is an invisible sliver.
const ACTIVITY_DAY_CLOCK_MIN_MINUTES = 8;

function formatActivityDuration(ms: number): string | null {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "<1m";
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest}m`;
  if (rest === 0) return `${hours}h`;
  return `${hours}h ${rest}m`;
}

function getZonedMinutesOfDay(value: string, timeZone: string): number | null {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", hour: "2-digit", minute: "2-digit" })
      .formatToParts(date);
    const hour = Number(parts.find((part) => part.type === "hour")?.value);
    const minute = Number(parts.find((part) => part.type === "minute")?.value);
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
    return hour * 60 + minute;
  } catch {
    return date.getHours() * 60 + date.getMinutes();
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
  const { t } = useLingui();
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
        title={t`Open in the BBCode editor`}
        aria-label={t`Open in the BBCode editor`}
        className="absolute top-2.5 right-2.5 z-10 w-8 h-8 flex items-center justify-center rounded-full bg-osu-b3/80 text-osu-l2 border border-osu-b3/40 hover:bg-osu-b2 hover:text-osu-c1 transition-colors cursor-pointer"
      >
        <Pencil size={14} />
      </button>
      <div
        ref={contentRef}
        className="bbcode-content bbcode-content--capped px-4 py-3 text-sm text-osu-l2 max-h-[520px] overflow-y-auto"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}

function BestScoresControlBar({
  availableKeyModes,
  keyFilter,
  onChangeKeyFilter,
  maxInlineKeyModes,
  keyModePlayCounts,
  onKeyModeOverflow,
  mods,
  modFilter,
  onCycleMod,
  onReverseCycleMod,
  onClearMods,
  sort,
  ppSort,
  ageSort,
  onChangeSort,
}: {
  availableKeyModes: string[];
  keyFilter: KeyFilter;
  onChangeKeyFilter: (keyFilter: KeyFilter) => void;
  maxInlineKeyModes: number;
  keyModePlayCounts: Record<string, number>;
  onKeyModeOverflow?: () => void;
  mods: string[];
  modFilter: ModFilterState;
  onCycleMod: (mod: string) => void;
  onReverseCycleMod: (mod: string) => void;
  onClearMods: () => void;
  sort: BestSort;
  ppSort: BestPpSort;
  ageSort: BestAgeSort;
  onChangeSort: (sort: BestSort) => void;
}) {
  const { t } = useLingui();
  const hasActiveFilter = Object.keys(modFilter).length > 0;

  return (
    <div className="mt-3 flex flex-col gap-2 lg:flex-row lg:items-start lg:justify-between">
      <div className="order-2 flex items-center gap-2 flex-wrap min-w-0 lg:order-1">
        <span className="text-[9px] uppercase tracking-wider text-osu-f1 font-semibold shrink-0">{t`Mods`}</span>
        {mods.length === 0 ? (
          <span className="text-[11px] text-osu-f1">{t`No mods in top plays`}</span>
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
                {t`Clear`}
              </button>
            )}
          </>
        )}
      </div>
      <div className="order-1 flex w-full min-w-0 flex-nowrap items-center justify-between gap-2 lg:order-2 lg:w-auto lg:flex-col lg:items-end lg:justify-start">
        {availableKeyModes.length > 1 && (
          // Shrinks so the keymode strip scrolls inside itself instead of pushing
          // the sort buttons off the right edge (a 4K-to-18K player overflows).
          <div className="min-w-0 flex-1 lg:hidden">
            <KeyModeControl
              availableKeyModes={availableKeyModes}
              keyFilter={keyFilter}
              onChangeKeyFilter={onChangeKeyFilter}
              maxVisible={maxInlineKeyModes}
              playCounts={keyModePlayCounts}
              onOverflow={onKeyModeOverflow}
            />
          </div>
        )}
        <BestSortControl sort={sort} ppSort={ppSort} ageSort={ageSort} onChangeSort={onChangeSort} />
      </div>
    </div>
  );
}

function BestSortControl({
  sort,
  ppSort,
  ageSort,
  onChangeSort,
}: {
  sort: BestSort;
  ppSort: BestPpSort;
  ageSort: BestAgeSort;
  onChangeSort: (sort: BestSort) => void;
}) {
  const { t } = useLingui();
  const ppActive = sort === "pp-desc" || sort === "pp-asc";
  const ppArrow = ppSort === "pp-asc" ? "↑" : "↓";
  const nextPpSort: BestPpSort = ppActive
    ? (ppSort === "pp-desc" ? "pp-asc" : "pp-desc")
    : ppSort;
  const ageActive = sort === "newest" || sort === "oldest";
  const ageArrow = ageSort === "oldest" ? "↑" : "↓";
  const nextAgeSort: BestAgeSort = ageActive
    ? (ageSort === "newest" ? "oldest" : "newest")
    : ageSort;

  return (
    <div className="flex items-center gap-1 shrink-0">
      <span className="hidden text-[9px] uppercase tracking-wider text-osu-f1 font-semibold sm:inline">{t`Sort`}</span>
      <div className="flex items-center gap-0.5 rounded-lg bg-osu-b4/60 border border-osu-b3/20 p-0.5 sm:gap-1 sm:p-1">
        <button
          type="button"
          onClick={() => onChangeSort(nextPpSort)}
          title={ppSort === "pp-asc" ? t`Lowest PP first` : t`Highest PP first`}
          className={`px-2 py-1.5 rounded-md text-[10px] font-semibold transition-colors cursor-pointer sm:px-3 sm:text-[11px] ${ppActive
              ? "bg-osu-pink/15 text-osu-pink-light"
              : "text-osu-f1 hover:text-osu-l2 hover:bg-osu-b3/50"
            }`}
        >
          <span className="sm:hidden">PP {ppArrow}</span>
          <span className="hidden sm:inline">PP {ppArrow}</span>
        </button>
        <button
          type="button"
          onClick={() => onChangeSort(nextAgeSort)}
          title={ageSort === "oldest" ? t`Oldest first` : t`Newest first`}
          className={`px-2 py-1.5 rounded-md text-[10px] font-semibold transition-colors cursor-pointer sm:px-3 sm:text-[11px] ${ageActive
              ? "bg-osu-pink/15 text-osu-pink-light"
              : "text-osu-f1 hover:text-osu-l2 hover:bg-osu-b3/50"
            }`}
        >
          <Trans>Age {ageArrow}</Trans>
        </button>
      </div>
    </div>
  );
}

/**
 * Which keymodes a crowded strip keeps inline, and which fall to the overflow.
 *
 * A profile with 4K through 18K on it has more chips than a phone row holds,
 * and they are not worth the same: two 18K plays are a novelty beside a 200
 * play 7K list. So the strip keeps the keymodes with the most plays, and the
 * rest go behind one chip. What is kept is still drawn in numeric order, since
 * ranking the chips themselves would move 4K around per profile.
 *
 * The active filter is always kept, or picking a keymode from the overflow
 * would hide the chip that says which one is on.
 */
export function selectVisibleKeyModes(
  availableKeyModes: string[],
  keyFilter: KeyFilter,
  playCounts: Record<string, number>,
  maxVisible: number,
): string[] {
  if (availableKeyModes.length <= maxVisible) return availableKeyModes;
  const ranked = [...availableKeyModes].sort((a, b) =>
    (playCounts[b] ?? 0) - (playCounts[a] ?? 0)
    || Number(a.replace("k", "")) - Number(b.replace("k", "")));
  const kept = new Set(ranked.slice(0, Math.max(1, maxVisible)));
  if (keyFilter !== "all") kept.add(keyFilter);
  return availableKeyModes.filter((keyMode) => kept.has(keyMode));
}

function KeyModeControl({
  availableKeyModes,
  keyFilter,
  onChangeKeyFilter,
  maxVisible,
  playCounts,
  onOverflow,
}: {
  availableKeyModes: string[];
  keyFilter: KeyFilter;
  onChangeKeyFilter: (keyFilter: KeyFilter) => void;
  /** Chips to keep inline before the rest collapse. Unset keeps all of them. */
  maxVisible?: number;
  playCounts?: Record<string, number>;
  /** Opens the fuller picker. Without one the strip keeps every chip. */
  onOverflow?: () => void;
}) {
  const { t } = useLingui();
  const visibleKeyModes = useMemo(() => (
    maxVisible == null || !onOverflow
      ? availableKeyModes
      : selectVisibleKeyModes(availableKeyModes, keyFilter, playCounts ?? {}, maxVisible)
  ), [availableKeyModes, keyFilter, maxVisible, onOverflow, playCounts]);
  const hiddenCount = availableKeyModes.length - visibleKeyModes.length;

  return (
    // Someone who plays every keymode makes this strip wider than a phone. It
    // scrolls inside its own box rather than running off the screen, and the
    // box never grows past its parent, so the sort buttons beside it stay put.
    <div className="inline-flex max-w-full items-center gap-0.5 overflow-x-auto scrollbar-hide rounded-lg bg-osu-b4/60 border border-osu-b3/20 p-0.5 sm:gap-1 sm:p-1 lg:shrink-0">
      {[["all", t`All`] as const, ...visibleKeyModes.map((k) => [k, k.toUpperCase()] as const)].map(([value, label]) => (
        <button
          key={value}
          onClick={() => onChangeKeyFilter(value)}
          className={`shrink-0 px-2 py-1.5 rounded-md text-[10px] font-semibold transition-colors cursor-pointer sm:px-3 sm:text-[11px] ${keyFilter === value
              ? "bg-osu-pink/15 text-osu-pink-light"
              : "text-osu-f1 hover:text-osu-l2 hover:bg-osu-b3/50"
            }`}
        >
          {label}
        </button>
      ))}
      {hiddenCount > 0 && onOverflow && (
        /* The rest live in the PP by Keymode modal, which lists every keymode
           with what it is worth and how many plays it holds - more to go on
           than a menu of the same chips would give. */
        <button
          type="button"
          onClick={onOverflow}
          title={t`All keymodes`}
          className="shrink-0 px-2 py-1.5 rounded-md text-[10px] font-semibold text-osu-f1 transition-colors cursor-pointer hover:text-osu-l2 hover:bg-osu-b3/50 sm:px-3 sm:text-[11px]"
        >
          +{hiddenCount}
        </button>
      )}
    </div>
  );
}

function RecentOsuSourceButton({
  loading,
  loaded,
  fetchedAt,
  onFetch,
}: {
  loading: boolean;
  loaded: boolean;
  fetchedAt: string | null;
  onFetch: () => void;
}) {
  const { t } = useLingui();
  const [clockMs, setClockMs] = useState(() => Date.now());
  const fetchedAtMs = fetchedAt == null ? Number.NaN : Date.parse(fetchedAt);
  const refreshAtMs = fetchedAtMs + PLAYER_RECENT_OSU_REFRESH_COOLDOWN_MS;
  const refreshWaitMs = Number.isFinite(refreshAtMs) ? Math.max(0, refreshAtMs - clockMs) : 0;
  const coolingDown = loaded && refreshWaitMs > 0;
  const label = loading
    ? t`Loading…`
    : coolingDown
      ? t`Updated just now`
      : loaded
        ? t`osu! recents`
        : t`Load osu! recents`;
  const description = coolingDown
    ? t`osu! recents are loaded. Refresh available in ${formatRecentRefreshWait(refreshWaitMs)}.`
    : loaded
      ? t`Refresh failed or otherwise missed plays from osu!'s latest recent history.`
      : t`Add failed or otherwise missed plays from osu!'s latest recent history.`;

  useEffect(() => {
    if (!loaded || !Number.isFinite(refreshAtMs)) return;
    const remainingMs = refreshAtMs - Date.now();
    setClockMs(Date.now());
    if (remainingMs <= 0) return;

    const tick = window.setInterval(() => setClockMs(Date.now()), 1_000);
    const finish = window.setTimeout(() => {
      window.clearInterval(tick);
      setClockMs(Date.now());
    }, remainingMs);
    return () => {
      window.clearInterval(tick);
      window.clearTimeout(finish);
    };
  }, [loaded, refreshAtMs]);

  return (
    <button
      type="button"
      onClick={onFetch}
      disabled={loading || coolingDown}
      title={description}
      aria-label={description}
      className={`group inline-flex h-9 shrink-0 cursor-pointer items-center overflow-hidden rounded-lg border text-[10px] font-semibold transition-colors disabled:cursor-default ${
        coolingDown
          ? "border-osu-b3/20 bg-osu-b4/35 text-osu-f1/60"
          : loaded
            ? "border-osu-pink/30 bg-osu-pink/12 text-osu-pink-light hover:border-osu-pink/45 hover:bg-osu-pink/18"
            : "border-osu-b3/25 bg-osu-b4/55 text-osu-f1 hover:border-osu-pink/30 hover:text-osu-pink-light"
      } ${loading ? "opacity-60" : ""}`}
    >
      <span className="inline-flex h-full items-center gap-1.5 px-2.5 sm:px-3">
        <OsuLogo className="h-3.5 w-3.5" />
        {label}
      </span>
      {(loading || loaded) && (
        <span className={`inline-flex h-4 w-6 items-center justify-center border-l ${
          coolingDown ? "border-osu-b3/30 text-osu-f1/55" : "border-osu-pink/25"
        }`}>
          {coolingDown
            ? <Check size={11} />
            : <RefreshCw size={10} className={loading ? "animate-spin" : "transition-transform group-hover:rotate-45"} />}
        </span>
      )}
    </button>
  );
}

function formatRecentRefreshWait(waitMs: number): string {
  const totalSeconds = Math.max(1, Math.ceil(waitMs / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
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
  const { t } = useLingui();
  const groupMods = getModFilterGroup(mod);
  const label = mod === NO_MOD_KEY
    ? t`NoMod`
    : groupMods
      ? groupMods.join(t` or `)
      : mod;
  const title = mode === "include"
    ? t`Showing only ${label}`
    : mode === "exclude"
      ? t`Hiding ${label}`
      : t`Click to require ${label}`;

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
          <span className="text-[10px] font-bold text-osu-l2 px-1">{t`NoMod`}</span>
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

// A stat on the flat rail under the hero: quiet label, the number carrying the
// weight. No box, the rail's hairline does the separating.
function RailStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[9px] font-semibold uppercase tracking-[0.18em] text-osu-f1">{label}</div>
      <div className="mt-1.5 text-[19px] font-bold leading-none tabular-nums text-white">{value}</div>
    </div>
  );
}

// A headline figure inside the hero, sitting over the cover art.
function HeroStat({
  label,
  value,
  valueClassName = "text-white",
  sub,
}: {
  label: string;
  value: ReactNode;
  valueClassName?: string;
  sub?: ReactNode;
}) {
  return (
    <div className="min-w-0">
      <div className="text-[9px] font-semibold uppercase tracking-[0.18em] text-white/40">{label}</div>
      <div className={`mt-2 text-[26px] font-black leading-none tabular-nums sm:text-[34px] ${valueClassName}`}>
        {value}
      </div>
      <div className="mt-2 min-h-[13px] text-[10px] leading-none text-white/45">{sub}</div>
    </div>
  );
}

// The 90-day global rank history, drawn edge to edge along the bottom of the
// hero. Higher rank number = worse = lower on the chart.
function RankTrendline({ history }: { history: number[] }) {
  if (history.length < 2) return null;
  const w = 1000;
  const h = 100;
  const max = Math.max(...history);
  const min = Math.min(...history);
  const range = max - min || 1;
  const points = history
    .map((value, index) => {
      const x = (index / (history.length - 1)) * w;
      const y = ((value - min) / range) * (h - 8) + 4;
      return `${x},${y}`;
    })
    .join(" ");
  const stroke = "hsl(var(--theme-hue),calc(100% * var(--theme-sat)),70%)";

  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      className="pointer-events-none absolute inset-x-0 bottom-0 h-[42%] w-full"
      aria-hidden
    >
      <defs>
        <linearGradient id="playerRankTrend" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={stroke} stopOpacity="0.2" />
          <stop offset="100%" stopColor={stroke} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={`0,${h} ${points} ${w},${h}`} fill="url(#playerRankTrend)" />
      <polyline
        points={points}
        fill="none"
        stroke={stroke}
        strokeWidth="2"
        strokeOpacity="0.55"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

// The insight cells live in one panel: 1px gaps let the parent colour through
// as hairlines, so four readings read as a single object instead of four boxes.
const INSIGHT_PANEL_CLASS = "grid grid-cols-2 gap-px overflow-hidden rounded-xl bg-osu-b3/30 lg:grid-cols-4";
const INSIGHT_CELL_CLASS = "flex min-h-[108px] flex-col bg-osu-b4 p-4";
const INSIGHT_CELL_INTERACTIVE_CLASS = "cursor-pointer transition-colors duration-150 hover:bg-osu-b3/40";
const INSIGHT_LABEL_CLASS = "text-[9px] font-semibold uppercase tracking-[0.18em] text-osu-f1";

// Fixed hues only: osu-pink is derived from --theme-hue, so on a blue or
// purple theme it collapsed onto 4K's blue or 6K's purple. Keymode identity
// has to read the same under every theme, and 4K/7K (the pair that almost
// always appears together) get complementary ends of the range.
// The two-stage keymodes (12K up) take the other shade of the keymode each one
// doubles, so 18K reads as 9K's deeper red and nothing above 10K falls back to
// a colourless bar. 10K already worked this way against 5K.
const KEYMODE_BAR_COLORS: Record<number, string> = { 4: "bg-osu-blue", 5: "bg-osu-green-light", 6: "bg-osu-purple-light", 7: "bg-osu-orange", 8: "bg-osu-yellow", 9: "bg-osu-red-light", 10: "bg-osu-green", 12: "bg-osu-purple", 14: "bg-osu-orange-dark", 16: "bg-osu-yellow-light", 18: "bg-osu-red" };
const KEYMODE_TEXT_COLORS: Record<number, string> = { 4: "text-osu-blue", 5: "text-osu-green-light", 6: "text-osu-purple-light", 7: "text-osu-orange", 8: "text-osu-yellow", 9: "text-osu-red-light", 10: "text-osu-green-light", 12: "text-osu-purple", 14: "text-osu-orange-dark", 16: "text-osu-yellow-light", 18: "text-osu-red" };
// A keymode total counts only what the top-200 window still holds, so mark it
// as a floor once the plays below the cutoff could move it by more than this.
const KEY_PP_FLOOR_RATIO = 0.02;

function isKeyPpFloor(bucket: UserProfileInsights["keyPp"][number]): boolean {
  return bucket.missingBound > bucket.weightedPp * KEY_PP_FLOOR_RATIO;
}

function KeySplitCard({ keySplit, sampleSize, onOpen, onPrefetch }: { keySplit: UserProfileInsights["keySplit"]; sampleSize: number; onOpen?: () => void; onPrefetch?: () => void }) {
  const { t } = useLingui();
  const colors = KEYMODE_BAR_COLORS;
  const textColors = KEYMODE_TEXT_COLORS;
  // keySplit stays in keymode order, so the dominant share has to be found.
  const dominantCount = keySplit.reduce((top, entry) => Math.max(top, entry.count), 0);

  return (
    <button
      type="button"
      className={`${INSIGHT_CELL_CLASS} group w-full text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-osu-pink/50 ${onOpen ? INSIGHT_CELL_INTERACTIVE_CLASS : "cursor-default"}`}
      onClick={onOpen}
      // Hovering or tabbing to the card is the earliest honest signal that the
      // totals are about to be read, and it buys the fetch a head start.
      onPointerEnter={onPrefetch}
      onFocus={onPrefetch}
      disabled={!onOpen}
    >
      <div className="flex items-center justify-between">
        <div className={INSIGHT_LABEL_CLASS}>{t`Key Split`}</div>
        {onOpen && <ExpandHint />}
      </div>
      {keySplit.length === 0 ? (
        <div className="mt-2 text-sm text-osu-f1">{t`No key data`}</div>
      ) : keySplit.length === 1 ? (
        // A single keymode carries no split to show, so the keymode itself is
        // the reading.
        <div className={`mt-2 text-[26px] font-black leading-none ${textColors[keySplit[0].keyCount] ?? "text-white"}`}>
          <Trans>{keySplit[0].keyCount}K only</Trans>
        </div>
      ) : (
        <>
          {/* The keymode someone actually plays gets the big number; the rest
              stay legible without competing with it. */}
          <div className="mt-2.5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            {keySplit.map((b) => (
              <div key={b.keyCount} className="flex items-baseline gap-1">
                <span
                  className={`font-black leading-none tabular-nums ${b.count === dominantCount ? "text-[26px]" : "text-[17px]"} ${textColors[b.keyCount] ?? "text-white"}`}
                >
                  {Math.round((b.count / sampleSize) * 100)}
                  <span className="text-[13px]">%</span>
                </span>
                <span className={`text-[11px] font-bold ${textColors[b.keyCount] ?? "text-osu-f1"}`}>{b.keyCount}K</span>
              </div>
            ))}
          </div>
          <div className="mt-auto w-full pt-3">
            <div className="flex h-1 overflow-hidden rounded-full bg-osu-b3/50">
              {keySplit.map((b) => (
                <div
                  key={b.keyCount}
                  className={`${colors[b.keyCount] ?? "bg-osu-b1"} transition-all duration-300`}
                  style={{ width: `${(b.count / sampleSize) * 100}%` }}
                />
              ))}
            </div>
          </div>
        </>
      )}
    </button>
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
  const { t } = useLingui();
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
          <div className="text-[9px] text-osu-f1">{t`BPM`}</div>
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
  const locale = useLocale();
  const { t } = useLingui();
  const viewerTimeZone = useViewerTimeZone();
  if (!snapshot) {
    return (
      <div className="h-[120px] rounded-xl bg-osu-b4 p-4">
        <div className={INSIGHT_LABEL_CLASS}>{label}</div>
        <div className="mt-2 text-sm text-osu-f1">{t`No data`}</div>
      </div>
    );
  }

  const href = snapshot.scoreUrl ?? snapshot.beatmapUrl;

  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="group/topplay relative block h-[120px] overflow-hidden rounded-xl bg-osu-b4 ring-1 ring-inset ring-white/[0.06] transition duration-150 hover:ring-osu-pink/40"
    >
      {snapshot.coverUrl && (
        <img
          src={snapshot.coverUrl}
          alt=""
          className="absolute -inset-px h-[calc(100%+2px)] w-[calc(100%+2px)] max-w-none object-cover brightness-[0.38] transition-transform duration-500 group-hover/topplay:scale-[1.03]"
        />
      )}
      <div className="absolute -inset-px bg-gradient-to-r from-black/60 via-black/20 to-black/45" />
      <div className="relative flex h-full items-center gap-3 p-4">
        <div className="min-w-0 flex-1">
          <div className="text-[9px] font-semibold uppercase tracking-[0.18em] text-white/45">{label}</div>
          <div className="mt-1.5 truncate text-[15px] font-bold text-white">{snapshot.title}</div>
          <div className="truncate text-[10px] text-white/55">{snapshot.artist} [{snapshot.version}]</div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <GradeImg grade={snapshot.rank} size={18} />
            {snapshot.mods.map((mod) => (
              <ModBadge key={mod} mod={mod} />
            ))}
            {/* Relative to Date.now(): the newest top play is usually minutes old,
                so SSR and hydration routinely land on different sides of a minute
                boundary. Let the client text win. */}
            <span className="text-[10px] text-white/45" suppressHydrationWarning>{formatTimeAgo(snapshot.date, locale)}</span>
            {/* The viewer's own day, like the score page this links to. A play
                set at 20:28 in Costa Rica is 02:28 UTC the next morning, and
                the UTC day dated it one day after osu! did. No
                suppressHydrationWarning needed: useViewerTimeZone holds UTC
                through the hydration render and the real zone arrives on the
                next one, as a normal diff. */}
            {snapshot.date && (
              <span className="hidden text-[10px] text-white/45 sm:inline">
                {formatDate(snapshot.date, viewerTimeZone)}
              </span>
            )}
          </div>
        </div>
        {snapshot.pp != null && (
          <div className="flex-shrink-0 text-right">
            <div className="text-[28px] font-black leading-none tabular-nums text-osu-pink-light">{Math.round(snapshot.pp)}</div>
            <div className="mt-1 text-[10px] font-semibold uppercase tracking-wider text-white/40">{t`pp`}</div>
          </div>
        )}
      </div>
    </a>
  );
}

function InsightsSkeleton() {
  return (
    <div className="space-y-3">
      <div className={INSIGHT_PANEL_CLASS}>
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className={INSIGHT_CELL_CLASS}>
            <Skeleton className="h-2.5 w-20" />
            <Skeleton className="mt-3 h-7 w-24" />
            <Skeleton className="mt-auto h-2.5 w-20" />
          </div>
        ))}
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {Array.from({ length: 2 }).map((_, i) => (
          <div key={i} className="h-[120px] rounded-xl bg-osu-b4 p-4">
            <Skeleton className="h-2.5 w-24" />
            <Skeleton className="mt-3 h-4 w-40" />
            <Skeleton className="mt-2 h-3 w-32" />
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

/** Which desktop metadata cells the current list needs. Reserving a cell that
 *  no visible row fills just pushes the map title away from its numbers, and
 *  skipping one a single row fills makes that row's numbers drift out of line
 *  with the rest, so the whole list agrees on the columns up front. */
type ScoreRowLayout = {
  /** Badge count of the widest mod set on screen; 0 drops the column. */
  modColumns: number;
  showLazer: boolean;
  showPp: boolean;
  showReplay: boolean;
};

const EMPTY_SCORE_ROW_LAYOUT: ScoreRowLayout = {
  modColumns: 0,
  showLazer: false,
  showPp: false,
  showReplay: false,
};

/** Keep in sync with ModBadge's intrinsic size and the gap-0.5 between badges. */
const MOD_BADGE_WIDTH = 36;
const MOD_BADGE_GAP = 2;

/* Every visible row, not just the window ones. A keymode list can be all
   tracked rows, and reading the layout off the window scores alone gave that
   list modColumns: 0 and showPp: false, which drops the mods and the feature's
   own number on desktop while mobile still shows both. showLazer stays a
   window-only signal: a tracked row has no lazer badge to align. */
export function getScoreRowLayout(rows: BestListRow[]): ScoreRowLayout {
  const layout = { ...EMPTY_SCORE_ROW_LAYOUT };
  for (const row of rows) {
    if (row.kind === "tracked") {
      const { play } = row;
      layout.modColumns = Math.max(layout.modColumns, getModDisplayList(play.mods.map((acronym) => ({ acronym }))).length);
      layout.showPp = true;
      if (play.hasReplay === true && play.soloScoreId != null) layout.showReplay = true;
      continue;
    }
    const { score } = row;
    layout.modColumns = Math.max(layout.modColumns, getModDisplayList(score.mods).length);
    if (getScoreDisplayValues(score).isLazer) layout.showLazer = true;
    if (score.pp != null) layout.showPp = true;
    if (scoreHasReplay(score)) layout.showReplay = true;
  }
  return layout;
}

const REPLAY_BUTTON_CLASS =
  "relative z-20 hidden flex-shrink-0 rounded-md border border-osu-pink/20 bg-osu-pink/15 px-2.5 py-1.5 text-[10px] font-semibold text-osu-pink-light sm:block";

/**
 * A play only this site's tracking has, drawn to sit in line with ScoreRow.
 *
 * It shows what the tracking stored and nothing else: combo and the replay
 * button are recorded at ingest, and a play from before that reads a dash
 * instead of a made-up zero. The cells it skips keep their width so the
 * numbers stay in their columns, and the details card it opens is built from
 * the same row rather than fetched.
 */
function TrackedScoreRow({
  play,
  position,
  layout = EMPTY_SCORE_ROW_LAYOUT,
  onOpenDetails,
}: {
  play: LiveKeymodePpPlay;
  position: number;
  layout?: ScoreRowLayout;
  onOpenDetails: (play: LiveKeymodePpPlay) => void;
}) {
  const locale = useLocale();
  const { t } = useLingui();
  const mods = getModDisplayList(play.mods.map((acronym) => ({ acronym })));
  const coverUrl = play.beatmapsetId ? `/api/background?beatmapsetId=${play.beatmapsetId}` : null;
  const canReplay = play.hasReplay === true && play.soloScoreId != null;

  return (
    <div className="player-score-row relative flex items-center gap-2 sm:gap-3 py-2.5 px-3 rounded-lg bg-osu-b4/50 hover:bg-osu-b4 transition-colors duration-[120ms] cursor-pointer">
      {/* Same full-row target as a window score. */}
      <button
        type="button"
        onClick={() => onOpenDetails(play)}
        aria-label={t`Show details for ${play.title || t`score`}`}
        className="absolute inset-0 z-0 rounded-lg cursor-pointer"
      />
      <span className="pointer-events-none relative z-10 sm:hidden text-xs text-osu-f1 font-bold flex-shrink-0">{position}.</span>
      <div
        className="score-position-indicator pointer-events-none absolute -left-14 top-1/2 -translate-y-1/2 w-10 text-right text-white/90 opacity-0 translate-x-2 transition-all duration-150 ease-out hidden sm:block"
        style={{ fontFamily: "Venera" }}
      >
        <span className="block text-[24px] leading-none">{position}</span>
      </div>
      <div className="pointer-events-none relative z-10 flex items-center gap-2 sm:gap-3 flex-1 min-w-0">
        <GradeImg grade={play.rank ?? "D"} size={28} />
        {coverUrl ? (
          <img src={coverUrl} alt="" className="w-12 h-8 rounded object-cover flex-shrink-0" loading="lazy" />
        ) : (
          <div className="w-12 h-8 rounded flex-shrink-0 border border-osu-b3/50 bg-osu-b4" />
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-white truncate">{play.title || t`Unknown`}</span>
            <span className="text-[11px] text-osu-f1 truncate hidden sm:inline">[{play.version}]</span>
            {play.keyCount > 0 && (
              <span className="px-1 py-0.5 rounded text-[8px] font-bold bg-osu-b3/50 text-osu-yellow flex-shrink-0">
                {play.keyCount}K
              </span>
            )}
          </div>
          <span className="text-[11px] text-osu-f1">
            {play.artist}
            {play.playedAt && (
              <>
                {" "}&middot;{" "}
                <span suppressHydrationWarning title={formatTimeAgoTooltip(play.playedAt, locale)}>
                  {formatTimeAgo(play.playedAt, locale)}
                </span>
              </>
            )}
          </span>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 sm:hidden">
            <div className="flex flex-wrap items-center gap-0.5">
              {mods.map((m) => (
                <ModBadge key={m.acronym} mod={m.acronym} rate={m.rate} size={0.82} />
              ))}
            </div>
            <div className="ml-auto flex flex-shrink-0 items-center gap-1.5">
              {play.accuracy != null && (
                <span className="whitespace-nowrap text-xs text-osu-l2 tabular-nums">{formatAccuracy(play.accuracy)}</span>
              )}
              {play.maxCombo != null && (
                <span className="whitespace-nowrap text-xs text-osu-f1 tabular-nums">{formatNumber(play.maxCombo)}x</span>
              )}
              <span className="whitespace-nowrap text-sm font-bold tabular-nums text-osu-pink-light">{formatPP(play.pp)}</span>
              {canReplay && (
                <Link
                  to="/replay"
                  search={{ scoreId: play.soloScoreId ?? undefined, beatmapsetId: play.beatmapsetId ?? undefined }}
                  title={t`Watch replay`}
                  aria-label={t`Watch replay`}
                  className="pointer-events-auto inline-flex h-5 w-5 flex-shrink-0 items-center justify-center rounded bg-osu-pink/20 text-[9px] font-semibold leading-none text-osu-pink-light transition-colors hover:bg-osu-pink/30"
                >
                  <span aria-hidden="true">&#9654;</span>
                </Link>
              )}
            </div>
          </div>
        </div>
        <div className="hidden sm:flex items-center gap-3 flex-shrink-0">
          {layout.modColumns > 0 && (
            <div
              className="flex flex-shrink-0 gap-0.5 justify-end"
              style={{ width: layout.modColumns * MOD_BADGE_WIDTH + (layout.modColumns - 1) * MOD_BADGE_GAP }}
            >
              {mods.map((m) => (
                <ModBadge key={m.acronym} mod={m.acronym} rate={m.rate} />
              ))}
            </div>
          )}
          {layout.showLazer && <div className="w-11 flex-shrink-0" />}
          <div className="flex items-center gap-2">
            <span className="w-14 text-right text-xs tabular-nums text-osu-l2">
              {play.accuracy != null ? formatAccuracy(play.accuracy) : "-"}
            </span>
            <span className={`w-14 text-right text-xs tabular-nums ${play.maxCombo != null ? "text-osu-f1" : "text-osu-f1/40"}`}>
              {play.maxCombo != null ? `${formatNumber(play.maxCombo)}x` : "-"}
            </span>
            {layout.showPp && (
              <span className="w-16 text-right text-sm font-bold tabular-nums text-osu-pink-light">{formatPP(play.pp)}</span>
            )}
          </div>
        </div>
      </div>
      {canReplay ? (
        <Link
          to="/replay"
          search={{ scoreId: play.soloScoreId ?? undefined, beatmapsetId: play.beatmapsetId ?? undefined }}
          title={t`Watch replay`}
          aria-label={t`Watch replay`}
          className={`pointer-events-auto relative z-10 transition-colors hover:bg-osu-pink/25 ${REPLAY_BUTTON_CLASS}`}
        >
          {t`Replay`}
        </Link>
      ) : layout.showReplay ? (
        <span aria-hidden="true" className={`pointer-events-none invisible ${REPLAY_BUTTON_CLASS}`}>
          {t`Replay`}
        </span>
      ) : null}
    </div>
  );
}

function ScoreRow({
  score,
  position,
  layout = EMPTY_SCORE_ROW_LAYOUT,
  onOpenDetails,
}: {
  score: OsuScore;
  position: number;
  layout?: ScoreRowLayout;
  onOpenDetails: (score: OsuScore) => void;
}) {
  const locale = useLocale();
  const { t } = useLingui();
  const scoreFallbackLabel = t`score`;
  const keymodeLabel = getBeatmapKeymodeLabel(score.beatmap);
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
            {score.beatmapset?.title || t`Unknown`}
          </span>
          <span className="text-[11px] text-osu-f1 truncate hidden sm:inline">
            [{score.beatmap?.version}]
          </span>
          {keymodeLabel && (
            <span className="px-1 py-0.5 rounded text-[8px] font-bold bg-osu-b3/50 text-osu-yellow flex-shrink-0">
              {keymodeLabel}
            </span>
          )}
          <span className="hidden sm:inline flex-shrink-0"><DanBadge score={score} /></span>
        </div>
        <span className="text-[11px] text-osu-f1">
          {score.beatmapset?.artist} &middot;{" "}
          {/* Fresh scores are minutes old, so this half drifts between SSR and
              hydration; the artist name stays hydration-checked. */}
          {/* pointer-events-auto opts this one span back into hit testing: the
              content layer is inert so the full-row overlay can take the
              clicks, and an element that never sees the pointer never shows its
              title. The click handler keeps the patch acting like the row. */}
          <span
            suppressHydrationWarning
            title={formatTimeAgoTooltip(getScoreTimestamp(score), locale)}
            className="pointer-events-auto"
            onClick={() => onOpenDetails(score)}
          >
            {formatTimeAgo(getScoreTimestamp(score), locale)}
          </span>
        </span>
        {/* Mobile-only metadata row */}
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 sm:hidden">
          <div className="flex max-w-full flex-shrink-0 flex-wrap items-center gap-1">
            <div className="flex flex-wrap items-center gap-0.5">
              {getModDisplayList(score.mods).map((m) => (
                <ModBadge key={m.acronym} mod={m.acronym} rate={m.rate} size={0.82} />
              ))}
            </div>
            <DanBadge score={score} />
          </div>
          <div className="ml-auto flex flex-shrink-0 items-center gap-1.5">
            <span className="whitespace-nowrap text-xs text-osu-l2 tabular-nums">{formatAccuracy(display.accuracy)}</span>
            <span className="whitespace-nowrap text-xs text-osu-f1 tabular-nums">{formatNumber(score.max_combo)}x</span>
            {hasPp && <span className="whitespace-nowrap text-sm font-bold tabular-nums text-osu-pink-light">{formatPP(score.pp)}</span>}
            {canReplay && (
              <Link
                to="/replay"
                search={{ scoreId: score.id, beatmapsetId: score.beatmapset?.id }}
                title={t`Watch replay`}
                aria-label={t`Watch replay`}
                className="pointer-events-auto inline-flex h-5 w-5 flex-shrink-0 items-center justify-center rounded bg-osu-pink/20 text-[9px] font-semibold leading-none text-osu-pink-light transition-colors hover:bg-osu-pink/30"
              >
                <span aria-hidden="true">&#9654;</span>
              </Link>
            )}
          </div>
        </div>
      </div>
      {/* Desktop metadata. The numeric cells get fixed widths so accuracy,
          combo and pp line up down the list instead of drifting per row; the
          mod and pp cells only exist when some visible row fills them. */}
      <div className="hidden sm:flex items-center gap-3 flex-shrink-0">
        {layout.modColumns > 0 && (
          <div
            className="flex flex-shrink-0 gap-0.5 justify-end"
            style={{ width: layout.modColumns * MOD_BADGE_WIDTH + (layout.modColumns - 1) * MOD_BADGE_GAP }}
          >
            {getModDisplayList(score.mods).map((m) => (
              <ModBadge key={m.acronym} mod={m.acronym} rate={m.rate} />
            ))}
          </div>
        )}
        {layout.showLazer && (
          <div className="flex w-11 flex-shrink-0 justify-end">{display.isLazer && <LazerBadge />}</div>
        )}
        {/* Accuracy, combo and pp read as one cluster, so they sit tighter
            together than the badge cells beside them. */}
        <div className="flex items-center gap-2">
          <span className="w-14 text-right text-xs tabular-nums text-osu-l2">{formatAccuracy(display.accuracy)}</span>
          <span className="w-14 text-right text-xs tabular-nums text-osu-f1">{formatNumber(score.max_combo)}x</span>
          {layout.showPp && (
            <span className="w-16 text-right text-sm font-bold tabular-nums text-osu-pink-light">
              {hasPp ? formatPP(score.pp) : ""}
            </span>
          )}
        </div>
      </div>
    </>
  );

  return (
    <div className="player-score-row relative flex items-center gap-2 sm:gap-3 py-2.5 px-3 rounded-lg bg-osu-b4/50 hover:bg-osu-b4 transition-colors duration-[120ms] cursor-pointer">
      {/* Full-row hit target. The osu! score page moved into the details modal,
          so this opens that instead of navigating away. */}
      <button
        type="button"
        onClick={() => onOpenDetails(score)}
        aria-label={t`Show details for ${score.beatmapset?.title || scoreFallbackLabel}`}
        className="absolute inset-0 z-0 rounded-lg cursor-pointer"
      />
      {/* Mobile inline position number */}
      <span className="pointer-events-none relative z-10 sm:hidden text-xs text-osu-f1 font-bold flex-shrink-0">{position}.</span>
      {/* Desktop hover position number */}
      <div
        className="score-position-indicator pointer-events-none absolute -left-14 top-1/2 -translate-y-1/2 w-10 text-right text-white/90 opacity-0 translate-x-2 transition-all duration-150 ease-out hidden sm:block"
        style={{ fontFamily: "Venera" }}
      >
        <span className="block text-[24px] leading-none">{position}</span>
      </div>
      <div className="pointer-events-none relative z-10 flex items-center gap-2 sm:gap-3 flex-1 min-w-0">
        {content}
      </div>
      {canReplay ? (
        <Link
          to="/replay"
          search={{ scoreId: score.id, beatmapsetId: score.beatmapset?.id }}
          title={t`Watch replay`}
          aria-label={t`Watch replay`}
          className={`pointer-events-auto transition-colors hover:bg-osu-pink/25 ${REPLAY_BUTTON_CLASS}`}
        >
          {t`Replay`}
        </Link>
      ) : layout.showReplay ? (
        // Rows without a stored replay still hold the slot, otherwise their
        // numbers sit a button-width right of the rows that have one.
        <span aria-hidden="true" className={`pointer-events-none invisible ${REPLAY_BUTTON_CLASS}`}>
          {t`Replay`}
        </span>
      ) : null}
    </div>
  );
}

/** Value first, label under it: the number is what people came for, so it
 *  carries the weight and the caption stays out of the way. */
function ScoreDetailStat({ label, value, color }: { label: string; value: ReactNode; color?: string }) {
  return (
    <div>
      <div className={`text-base font-bold leading-none tabular-nums ${color ?? "text-white"}`}>{value}</div>
      <div className="mt-1 text-[9px] uppercase tracking-wider text-osu-f1 font-semibold">{label}</div>
    </div>
  );
}

/** Everything the row can't fit: total score, judgement spread, map metadata,
 *  and the links (osu! page, replay) the row used to navigate to on its own. */
function ScoreDetailModal({ score, onClose }: { score: OsuScore; onClose: () => void }) {
  const { t } = useLingui();
  const locale = useLocale();
  const scoreTitleFallback = t`Score`;
  const display = getScoreDisplayValues(score);
  /* A play whose judgement counts were never stored (a tracked play from
     before the day-best rows kept them) would otherwise draw six zeros, which
     reads as a real score of nothing. The grid is dropped instead. */
  const judgements = getManiaJudgementStats(score);
  const hasJudgements = judgements.some((judgement) => judgement.value > 0);
  const mods = getModDisplayList(score.mods);
  const keymodeLabel = getBeatmapKeymodeLabel(score.beatmap);
  const scoreUrl = getScoreUrl(score);
  const beatmapUrl = getBeatmapUrl(score);
  const canReplay = scoreHasReplay(score);
  const hasPp = score.pp != null;
  const playedAt = getScoreTimestamp(score);
  const viewerTimeZone = useViewerTimeZone();
  const cover = score.beatmapset?.covers?.["cover@2x"] || score.beatmapset?.covers?.cover;

  return (
    <motion.div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 sm:backdrop-blur-sm cursor-pointer p-4"
      onClick={onClose}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
    >
      <motion.div
        role="dialog"
        aria-modal="true"
        aria-label={t`${score.beatmapset?.title ?? scoreTitleFallback} details`}
        className="modal-card-mobile-safe relative isolate bg-osu-b4 border border-osu-b3/20 rounded-2xl w-[520px] max-w-full max-h-[85vh] overflow-hidden shadow-[0_12px_60px_rgba(0,0,0,0.7)] cursor-default"
        onClick={(e) => e.stopPropagation()}
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 8 }}
        transition={{ duration: 0.16, ease: "easeOut" }}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label={t`Close`}
          className="absolute top-3 right-3 z-20 w-7 h-7 flex items-center justify-center rounded-full bg-black/30 text-white/80 hover:text-white hover:bg-black/50 transition-colors cursor-pointer"
        >
          <X size={14} />
        </button>

        <div className="max-h-[85vh] overflow-y-auto">
          {/* The cover gets a banner of its own instead of washing over the
              whole card, where it fought every number for contrast. */}
          <div className="relative h-[104px] overflow-hidden">
            {cover && (
              <img
                src={cover}
                alt=""
                className="absolute inset-0 h-full w-full object-cover"
                style={{ filter: "brightness(0.42) saturate(1.1)" }}
              />
            )}
            <div className="absolute inset-0 bg-gradient-to-b from-osu-b4/10 via-osu-b4/55 to-osu-b4" />
            {/* Mods belong with the map they were played on, not floating in
                the middle of the numbers row. */}
            <div className="relative flex h-full items-end justify-between gap-3 px-4 pb-3 sm:px-5">
              <div className="min-w-0">
                <div className="flex items-center gap-2 min-w-0">
                  {beatmapUrl ? (
                    <a
                      href={beatmapUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-lg font-semibold text-white truncate hover:text-osu-pink-light underline-offset-2 hover:underline"
                      title={t`Open beatmap on osu!`}
                    >
                      {score.beatmapset?.title || t`Unknown`}
                    </a>
                  ) : (
                    <span className="text-lg font-semibold text-white truncate">
                      {score.beatmapset?.title || t`Unknown`}
                    </span>
                  )}
                  {keymodeLabel && (
                    <span className="px-1 py-0.5 rounded text-[8px] font-bold bg-osu-b3/50 text-osu-yellow flex-shrink-0">
                      {keymodeLabel}
                    </span>
                  )}
                  <DanBadge score={score} />
                </div>
                <div className="mt-0.5 truncate text-[11px] text-osu-f1">
                  {score.beatmapset?.artist}
                  {score.beatmap?.version ? ` · [${score.beatmap.version}]` : ""}
                  {score.beatmapset?.creator ? ` · ${t`mapped by ${score.beatmapset.creator}`}` : ""}
                </div>
              </div>
              {(mods.length > 0 || display.isLazer) && (
                <div className="flex flex-shrink-0 flex-wrap items-center justify-end gap-1 pb-0.5">
                  {mods.map((m) => (
                    <ModBadge key={m.acronym} mod={m.acronym} rate={m.rate} />
                  ))}
                  {display.isLazer && <LazerBadge />}
                </div>
              )}
            </div>
          </div>

          <div className="px-4 pt-4 pb-5 sm:px-5">
            {/* Grade, accuracy and the headline number carry the card; pp is
                the headline where it exists, total score where it doesn't. */}
            <div className="flex items-center gap-3 sm:gap-4">
              <GradeImg grade={display.rank} size={46} />
              <div>
                <div className="text-2xl font-bold leading-none tabular-nums text-white sm:text-3xl">
                  {formatAccuracy(display.accuracy)}
                </div>
                <div className="mt-1.5 text-[9px] uppercase tracking-wider text-osu-f1 font-semibold">{t`Accuracy`}</div>
              </div>
              <div className="ml-auto text-right">
                <div
                  className={`text-2xl font-bold leading-none tabular-nums sm:text-3xl ${hasPp ? "text-osu-pink-light" : "text-white"}`}
                >
                  {hasPp ? formatPP(score.pp) : display.totalScore != null ? formatNumber(display.totalScore) : "-"}
                </div>
                <div className="mt-1.5 text-[9px] uppercase tracking-wider text-osu-f1 font-semibold">
                  {/* Best-play rows know how much of this actually reaches the
                      profile total, which beats repeating the raw pp. */}
                  {hasPp ? (score.weight ? t`${Math.round(score.weight.percentage)}% weighted` : t`PP`) : t`Score`}
                </div>
              </div>
            </div>

            {/* Narrow screens wrap these into 3x2 and 2x2 blocks; centring the
                cells there keeps the wrapped rows reading as a grid instead of
                as columns with ragged space to their right. */}
            {hasJudgements && (
              <div className="mt-5 grid grid-cols-3 gap-3 text-center sm:grid-cols-6 sm:text-left">
                {judgements.map((judgement) => (
                  <ScoreDetailStat
                    key={judgement.label}
                    label={judgement.label}
                    value={formatNumber(judgement.value)}
                    color={judgement.className}
                  />
                ))}
              </div>
            )}

            <div className="mt-5 grid grid-cols-2 gap-3 text-center sm:grid-cols-4 sm:text-left">
              <ScoreDetailStat label={t`Combo`} value={score.max_combo ? `${formatNumber(score.max_combo)}x` : "-"} />
              {hasPp && (
                <ScoreDetailStat
                  label={t`Score`}
                  value={display.totalScore ? formatNumber(display.totalScore) : "-"}
                />
              )}
              <ScoreDetailStat
                label={t`Stars`}
                value={
                  score.beatmap?.difficulty_rating != null
                    ? <StarRatingBadge stars={score.beatmap.difficulty_rating} size={1.4} />
                    : "-"
                }
              />
              <ScoreDetailStat
                label={t`BPM`}
                value={score.beatmap?.bpm != null ? String(Math.round(score.beatmap.bpm)) : "-"}
              />
            </div>

            <div className="mt-5 flex flex-col gap-3 border-t border-osu-b3/20 pt-3 sm:flex-row sm:items-center sm:justify-between sm:gap-2">
              <span className="text-[11px] text-osu-f1" suppressHydrationWarning title={formatDate(playedAt, viewerTimeZone)}>
                <Trans>Played {formatDetailedTimeAgo(playedAt, locale)} on {display.isLazer ? "Lazer" : "Stable"}</Trans>
              </span>
              <div className="flex items-center justify-between gap-3 sm:justify-end">
                {/* A tracked play whose row never kept a score id has no page
                    on osu! to open, so the link falls back to the map it was
                    set on rather than leaving the card with nothing to follow. */}
                {(scoreUrl ?? beatmapUrl) && (
                  <a
                    href={scoreUrl ?? beatmapUrl ?? undefined}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-[11px] text-osu-f1 hover:text-osu-pink-light transition-colors"
                  >
                    {scoreUrl ? t`View on osu!` : t`Open beatmap on osu!`}
                    <ExternalLink size={11} className="shrink-0" />
                  </a>
                )}
                {canReplay && (
                  <Link
                    to="/replay"
                    search={{ scoreId: score.id, beatmapsetId: score.beatmapset?.id }}
                    className="rounded-md border border-osu-pink/20 bg-osu-pink/15 px-2.5 py-1.5 text-[10px] font-semibold text-osu-pink-light transition-colors hover:bg-osu-pink/25"
                  >
                    {t`Watch replay`}
                  </Link>
                )}
              </div>
            </div>
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}
