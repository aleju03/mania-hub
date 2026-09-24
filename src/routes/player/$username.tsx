import { Link, createFileRoute, useLocation, useNavigate } from "@tanstack/react-router";
import { Suspense, lazy, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Check, Pencil, Plus, RefreshCw } from "lucide-react";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { msg } from "@lingui/core/macro";
import type { MessageDescriptor } from "@lingui/core";
import {
  getUser,
  getUserScoresBestWindow,
} from "../../lib/osu";
import {
  fetchLivePlayerCachedProfileSnapshot,
  fetchLivePlayerAboutDirect,
  fetchLivePlayerKeymodePpDirect,
  fetchLivePlayerKeymodePpKeysDirect,
  fetchLivePlayerProfileSnapshotDirect,
  fetchLivePlayerRecentScoresDirect,
  fetchLivePlayerSkillsDirect,
  fetchRestrictedPpPlayerDirect,
  isLiveBackendConfigured,
  type LivePlayerSkills,
  type LiveKeymodePpPlay,
  type LivePlayerKeymodePpTail,
  type LivePlayerProfileSnapshot,
  type RestrictedPpPlayer,
} from "../../lib/live-backend";
import {
  formatNumber,
  formatAccuracy,
  formatDetailedTimeAgo,
  formatDate,
} from "../../lib/format";
import { useHasHydrated, useNoDans, useRecentPlayRatings } from "../../store";
import { recentPlayRatingKey, useRecentPlayRatingLookup } from "../../components/player/recent-play-ratings";
import {
  getBeatmapKeyCount,
  
  getScoreIdentity,
  getScoreTimeMs,
} from "../../lib/score";
import { useAuth } from "../../lib/auth-context";
import { Segmented, SkillPlaysExplorer, prefetchSkillPlaysExplorerView, type SkillPlaysExplorerView } from "../../components/player/SkillPlaysExplorer";
import { SharedSkillPlay } from "../../components/player/SharedSkillPlay";
import { DisplayNameButton, DisplayNameForm, pendingRenameDate } from "../../components/player/DisplayNameEditor";
import { ServerLinkPill, ServerLinksButton } from "../../components/player/ServerLinks";
import { BBCodePreview } from "../../components/player/bbcode/BBCodePreview";
import { setMyOwnAbout } from "../../lib/own-profile";
import { GradeImg } from "../../components/ui/GradeImg";
import { OsuLogo } from "../../components/ui/OsuLogo";
import { CountryFlag } from "../../components/ui/CountryFlag";
import { ModBadge } from "../../components/ui/ModBadge";
import { ScoreRowSkeleton, Skeleton } from "../../components/ui/LoadingSkeleton";
import { UsernameText } from "../../components/ui/UsernameText";
import { ManiaCard3DPanel as ManiaCardPanel, preloadManiaCard3DPanel } from "../../components/player/maniacard3d/LazyManiaCard3DPanel";
import { computeManiaSkills, type ManiaCardTier, type ManiaSkills } from "../../lib/maniacard";
import { SkillBreakdownBody, SkillModePanel, SkillModeOption } from "../../components/player/SkillBreakdown";
import { qualifyingSkillModes, skillRatingAccent, type SkillAxisEntry } from "../../lib/skill-axes";
import { SkillPlaysModal } from "../../components/player/SkillPlaysModal";
import { AddScoreModal } from "../../components/player/AddScoreModal";
import { DanEvidenceModal } from "../../components/player/DanEvidenceModal";
import { SkillsUntrackedNotice } from "../../components/player/SkillsUntrackedNotice";
import { buildRestrictedBestList, profileRailTotals } from "../../components/player/restricted-best-scores";
import { companellaImportsToScores, dropCompanellaOsuTwins } from "../../lib/companella-scores";
import type { OsuCovers, OsuScore, OsuUser, UserProfileInsights } from "../../lib/types";
import { calculateUserProfileInsights, KEY_PP_LIST_LIMIT } from "../../lib/profile-insights";
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
import {
  
  cycleModFilterMode,
  
  matchesModAcronymFilter,
  
  reverseCycleModFilterMode,
  type ModFilterMode,
  type ModFilterState,
} from "../../lib/mod-filter";
// The two cycling helpers keep their old home in the route's public surface:
// the mod-filter tests import them from here.
export { cycleModFilterMode, matchesModAcronymFilter, reverseCycleModFilterMode, type ModFilterMode };
import { preservePlayerCountryFlagState } from "../../lib/player-profile-navigation";
import { ScoreDetailModal, ScoreRow, TrackedScoreRow, getScoreRowLayout, type BestListRow } from "../../components/player/ScoreRows";
import { PlayerActivityPanel } from "../../components/player/ActivityPanel";
import { BpmBreakdownModal, ModUsageModal, PpDistributionModal } from "../../components/player/InsightModals";
import {
  BestScoresControlBar,
  KeyModeControl,
  getAvailableKeyModes,
  getRelevantMods,
  getSortablePp,
  matchesBestKeyFilter,
  matchesKeyFilter,
  matchesModFilter,
  selectVisibleKeyModes,
  sortBestScores,
  type BestAgeSort,
  type BestPpSort,
  type BestSort,
  type KeyFilter,
} from "../../components/player/BestScoresControls";
// The keymode helpers keep their old home in the route's public surface: the
// best-list tests import them from here.
export { matchesBestKeyFilter, selectVisibleKeyModes };
import {
  ExpandHint,
  HeroStat,
  INSIGHT_CELL_CLASS,
  INSIGHT_CELL_INTERACTIVE_CLASS,
  INSIGHT_LABEL_CLASS,
  INSIGHT_PANEL_CLASS,
  InsightsSkeleton,
  KEYMODE_BAR_COLORS,
  KEYMODE_TEXT_COLORS,
  KeySplitCard,
  PlayerScoreRowSkeleton,
  RailStat,
  TopPlayCard,
} from "../../components/player/ProfileParts";

// The BBCode editor (toolbar + parser + preview) only loads when someone
// actually opens it; the about tab itself stays light.
const BBCodeEditorLazy = lazy(() => import("../../components/player/bbcode/BBCodeEditor"));
const GUEST_AVATAR_URL = "https://osu.ppy.sh/images/layout/avatar-guest@2x.png";

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
  keymodePlayCounts?: { keyCount: number; count: number }[];
  fetchedAt: string;
  userFetchedAt: string;
  isStale: boolean;
};
const playerSnapshotDataCache = new Map<string, { data: PlayerSnapshotData; expiresAt: number }>();
const playerSnapshotRequestCache = new Map<string, Promise<PlayerSnapshotData | null>>();
interface PlayerAboutData {
  html: string | null;
  raw: string | null;
  /** A restricted player's own page, written here: render `raw`. */
  own?: boolean;
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
const RESTRICTED_PP_LIVE_TIMEOUT_MS = 8_000;
// The backend rebuilds these standings at most once a minute.
const RESTRICTED_PP_CLIENT_CACHE_TTL = 60_000;
const restrictedPpDataCache = new Map<number, { data: RestrictedPpPlayer | null; expiresAt: number }>();
const restrictedPpRequestCache = new Map<number, Promise<RestrictedPpPlayer | null>>();
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
const PLAYER_TABS: PlayerTab[] = ["best", "recent", "skills", "about", "card", "activity"];

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
const NO_SCORES: OsuScore[] = [];

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
    ...(user.account_status ? { account_status: user.account_status } : {}),
    ...(user.display_name ? { display_name: user.display_name } : {}),
    ...(user.display_name_next_change_at ? { display_name_next_change_at: user.display_name_next_change_at } : {}),
    ...(user.server_links?.length ? { server_links: user.server_links } : {}),
    ...(user.team ? { team: user.team } : {}),
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

export type { BestListRow };
export { getScoreRowLayout };

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

/* An import and the osu! row for the same play never share an identity, so
   an osu! row arriving later takes the import's place here. */
function mergeRecentScores(current: OsuScore[], fetched: OsuScore[]): OsuScore[] {
  return sortRecentScores(dropCompanellaOsuTwins(dedupeScores([...fetched, ...current])));
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
    a.account_status === b.account_status &&
    a.display_name === b.display_name &&
    a.display_name_next_change_at === b.display_name_next_change_at &&
    JSON.stringify(a.server_links ?? []) === JSON.stringify(b.server_links ?? []) &&
    JSON.stringify(a.team ?? null) === JSON.stringify(b.team ?? null) &&
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
  restrictedPpDataCache.clear();
  restrictedPpRequestCache.clear();
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
        keymodeKeyCounts: snapshot.keymodeKeyCounts,
        keymodePlayCounts: snapshot.keymodePlayCounts,
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
    // The Companella imports ride next to the osu! plays and are cached with them.
    .then((section) => mergeRecentScores(section.payload, companellaImportsToScores(section.imports)))
    .then((dedupedScores) => {
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

/** Drops the cached recent list, so the next load reads the backend again. */
function forgetUserRecent(userId: number): void {
  userRecentDataCache.delete(userId);
  userRecentRequestCache.delete(userId);
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
      own: section?.payload.own === true,
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

function loadRestrictedPpCached(userId: number): Promise<RestrictedPpPlayer | null> {
  const cached = restrictedPpRequestCache.get(userId);
  if (cached) return cached;

  const request = withTimeout(fetchRestrictedPpPlayerDirect(userId), RESTRICTED_PP_LIVE_TIMEOUT_MS)
    .then((standing) => {
      restrictedPpDataCache.set(userId, {
        data: standing,
        expiresAt: Date.now() + RESTRICTED_PP_CLIENT_CACHE_TTL,
      });
      return standing;
    })
    .finally(() => {
      restrictedPpRequestCache.delete(userId);
    });

  restrictedPpRequestCache.set(userId, request);
  return request;
}

/** Undefined when nothing is cached; null is a cached "no standing". */
function readCachedRestrictedPp(userId: number): RestrictedPpPlayer | null | undefined {
  const cachedData = restrictedPpDataCache.get(userId);
  if (!cachedData) return undefined;
  if (cachedData.expiresAt <= Date.now()) {
    restrictedPpDataCache.delete(userId);
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
  const [renameOpen, setRenameOpen] = useState(false);
  const [best, setBest] = useState<OsuScore[]>(() => loaderBestScores);
  const [bestFilters, setBestFilters] = useState<PlayerBestFilterMetadata>(() => loaderBestFilters);
  const [maniaCardSkills, setManiaCardSkills] = useState<ManiaSkills | null>(() => loaderManiaCardSkills);
  const [recent, setRecent] = useState<OsuScore[]>([]);
  const [aboutHtml, setAboutHtml] = useState<string | null>(null);
  const [aboutRaw, setAboutRaw] = useState<string | null>(null);
  const [aboutOwn, setAboutOwn] = useState(false);
  const [aboutEditing, setAboutEditing] = useState(false);
  const [storedProfileInsights, setProfileInsights] = useState<UserProfileInsights | null>(() => loaderProfileInsights);
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
  /* Plays per keymode across the whole tail, which is what decides which chips
     the strip keeps inline. It rides in with the snapshot and is never revised,
     so the strip picks its chips once. */
  const [keyPpPlayCounts, setKeyPpPlayCounts] = useState<{ keyCount: number; count: number }[] | null>(
    () => loaderSnapshot?.keymodePlayCounts ?? null,
  );
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
  const [bpmModalOpen, setBpmModalOpen] = useState(false);
  const [ppModalOpen, setPpModalOpen] = useState(false);
  const [keyPpModalOpen, setKeyPpModalOpen] = useState(false);
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
  /* An account osu! turned away can have a stand-in for what osu! stopped
     serving: its Companella imports on ranked maps, priced the way osu!
     prices a stable score. Where there is one, the hero, the Best tab and the
     insights read it instead of the stored list, and none of the stored plays
     join it. Only an answer about this user counts, so the stored list never
     shows while it is being asked for; a null one (nothing priced, the account
     is back, a failed call) leaves the profile as it always was. */
  const [restrictedPp, setRestrictedPp] = useState<{ userId: number; standing: RestrictedPpPlayer | null } | null>(() => {
    const seededUser = loaderSnapshot?.user;
    const cached = seededUser?.account_status ? readCachedRestrictedPp(seededUser.id) : undefined;
    return seededUser && cached !== undefined ? { userId: seededUser.id, standing: cached } : null;
  });
  const restrictedPpPending = !!user?.account_status && restrictedPp?.userId !== user.id;
  const restrictedStanding = user?.account_status && restrictedPp?.userId === user.id ? restrictedPp.standing : null;
  const restrictedBest = useMemo(
    () => restrictedStanding
      ? buildRestrictedBestList(restrictedStanding.best, {
        id: restrictedStanding.userId,
        username: user?.username ?? "",
        avatar_url: user?.avatar_url ?? "",
        country_code: user?.country_code ?? "",
      })
      : null,
    [restrictedStanding, user?.avatar_url, user?.country_code, user?.username],
  );
  const storedProfileHidden = restrictedPpPending || restrictedBest != null;
  const shownBest = restrictedPpPending ? NO_SCORES : restrictedBest ?? best;
  const restrictedBestFilters = useMemo(
    () => restrictedBest ? buildPlayerBestFilterMetadata(restrictedBest) : null,
    [restrictedBest],
  );
  const shownBestFilters = restrictedPpPending ? EMPTY_PLAYER_BEST_FILTERS : restrictedBestFilters ?? bestFilters;
  const restrictedInsights = useMemo(
    () => restrictedBest ? calculateUserProfileInsights(restrictedBest) : null,
    [restrictedBest],
  );
  const profileInsights = restrictedInsights ?? storedProfileInsights;
  /* Recent follows Best there: the stored osu! plays stay hidden and only the
     account's Companella imports show, in the same list as anyone's. */
  const shownRecent = useMemo(
    () => user?.account_status ? recent.filter((score) => score.companella != null) : recent,
    [recent, user?.account_status],
  );

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
    // The stored plays never join a stand-in list, so it has no tail.
    if (!userId || !isLiveBackendConfigured() || storedProfileHidden) {
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
  }, [storedProfileHidden, user?.id]);

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
        if (!active) return;
        setKeyPpKeyCounts(keys.keyCounts);
        if (keys.playCounts) setKeyPpPlayCounts(keys.playCounts);
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
    if (keyFilter === "all" || !keyPpTail || !bestWindowComplete || storedProfileHidden) return [];
    const keyCount = Number(keyFilter.replace("k", ""));
    if (!Number.isFinite(keyCount) || keyCount <= 0) return [];
    const inWindow = new Set(
      best
        .filter((score) => getBeatmapKeyCount(score.beatmap) === keyCount && !score.beatmap?.convert)
        .map((score) => Number(score.beatmap?.id)),
    );
    return keyPpTail.plays.filter((play) => play.keyCount === keyCount && !inWindow.has(play.beatmapId));
  }, [best, bestWindowComplete, keyFilter, keyPpTail, storedProfileHidden]);

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
      setKeyPpPlayCounts(loaderSnapshot?.keymodePlayCounts ?? null);
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
    setAboutOwn(false);
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
      if (result.keymodePlayCounts) setKeyPpPlayCounts(result.keymodePlayCounts);
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
    // osu! 404s a restricted or missing account; the stored list is all there
    // is, unless its imports stand in for it (the effect below).
    if (user.account_status) {
      setBestWindowLoaded(true);
      setBestWindowComplete(true);
      setLoadingInsights(false);
      return;
    }

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
    const userId = user?.id;
    if (!userId || !user?.account_status) return;
    const cached = readCachedRestrictedPp(userId);
    if (cached !== undefined) {
      setRestrictedPp((current) => current?.userId === userId && current.standing === cached ? current : { userId, standing: cached });
      return;
    }

    let cancelled = false;
    loadRestrictedPpCached(userId)
      .then((standing) => {
        if (!cancelled) setRestrictedPp({ userId, standing });
      })
      .catch(() => {
        if (!cancelled) setRestrictedPp({ userId, standing: null });
      });

    return () => {
      cancelled = true;
    };
  }, [user?.account_status, user?.id]);

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
    if (!user || tab !== "about" || aboutHtml != null || aboutOwn) return;
    if (user.page?.html) {
      setAboutHtml(user.page.html);
      setAboutRaw(user.page.raw ?? null);
      return;
    }
    const cachedAbout = readCachedPlayerAbout(user.id);
    if (cachedAbout !== undefined) {
      setAboutHtml(cachedAbout.html);
      setAboutRaw(cachedAbout.raw);
      setAboutOwn(cachedAbout.own === true);
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
        setAboutOwn(about.own === true);
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
  }, [aboutHtml, aboutOwn, tab, user]);

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

  // A restricted account's Recent is its Companella imports alone, so the
  // refresh just reads them again: new plays come in and withdrawn ones leave.
  const [refreshingImports, setRefreshingImports] = useState(false);
  const handleRefreshImports = useCallback(async () => {
    if (!user || refreshingImports) return;
    setRefreshingImports(true);
    forgetUserRecent(user.id);
    try {
      setRecent(await loadUserRecentCached(user.id));
      setRecentHasMore(false);
      setRecentError(null);
    } catch {
      setRecentError(t`Couldn't load recent scores right now.`);
    } finally {
      setRefreshingImports(false);
    }
  }, [refreshingImports, user]);

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
      const fetched = [
        ...(Array.isArray(section.payload) ? section.payload : []),
        ...companellaImportsToScores(section.imports),
      ];
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

  const relevantBestMods = shownBestFilters.mods;
  const bestPositionByIdentity = useMemo(() => {
    const positions = new Map<string, number>();
    shownBest.forEach((score, index) => {
      positions.set(getScoreIdentity(score), index + 1);
    });
    return positions;
  }, [shownBest]);

  /* How much of this profile each keymode actually is, used to decide which
     chips are worth a tap when there are more keymodes than fit. The tail's own
     per-keymode counts are what rank them, not the insights': the insights are
     recalculated as the window fills and again when the tail's plays arrive, and
     two keymodes close together at the cutoff would trade the last inline chip
     each time, minutes after the strip was drawn. The tail counts land with the
     snapshot and never move. The window still speaks for a keymode played before
     this site tracked the player, where the tail has less of it than osu! does. */
  const keyModePlayCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const score of shownBest) {
      const keyCount = getBeatmapKeyCount(score.beatmap);
      if (keyCount == null) continue;
      const key = `${keyCount}k`;
      counts[key] = (counts[key] ?? 0) + 1;
    }
    for (const bucket of storedProfileHidden ? [] : keyPpPlayCounts ?? []) {
      const key = `${bucket.keyCount}k`;
      counts[key] = Math.max(counts[key] ?? 0, bucket.count);
    }
    return counts;
  }, [keyPpPlayCounts, shownBest, storedProfileHidden]);

  /* Recent ranks its own chips by what the player has actually been playing.
     The pp counts above are the wrong order here: a keymode whose plays are
     all unranked is worth 0pp and would sit behind the overflow chip even on a
     day it is every play on the page. */
  const recentKeyModePlayCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const score of shownRecent) {
      const keyCount = getBeatmapKeyCount(score.beatmap);
      if (keyCount == null) continue;
      const key = `${keyCount}k`;
      counts[key] = (counts[key] ?? 0) + 1;
    }
    return counts;
  }, [shownRecent]);

  /* Five keeps All plus the mains on one phone row. Past that the strip is
     wider than the screen and the chips at the end are unreachable without a
     swipe nothing announces. */
  const MAX_INLINE_KEY_MODES = 5;
  /* The desktop header shares its row with the tabs, so the strip gets more
     chips than a phone but still has to stop before it pushes About off. */
  const MAX_INLINE_KEY_MODES_WIDE = 8;

  /* Each tab offers the keymodes its own list holds, and no others: the two
     lists are different sets of plays, so one strip over both puts up a chip
     that filters to nothing on whichever tab does not have that keymode. */
  const bestAvailableKeyModes = useMemo(() => {
    const modes = new Set(shownBestFilters.keyModes);
    // A keymode can exist entirely below the osu! window (every 5K play worth
    // less than the 200th), and the chip has to be there or the list this site
    // can show has no way to be asked for.
    if (!storedProfileHidden) {
      for (const keyCount of keyPpKeyCounts ?? []) modes.add(`${keyCount}k`);
      for (const play of keyPpTail?.plays ?? []) modes.add(`${play.keyCount}k`);
    }
    return [...modes].sort((a, b) => Number(a.replace("k", "")) - Number(b.replace("k", "")));
  }, [keyPpKeyCounts, keyPpTail, shownBestFilters.keyModes, storedProfileHidden]);
  /* Recent is only what is on the page. A keymode nobody has played lately is
     not a filter here even when the profile is full of it, and an unranked
     play still counts, which is why the pp keymodes have no say. */
  const recentAvailableKeyModes = useMemo(() => getAvailableKeyModes(shownRecent), [shownRecent]);
  const availableKeyModes = tab === "recent" ? recentAvailableKeyModes : bestAvailableKeyModes;

  /* The filter carries across tabs, so opening one with no plays in that
     keymode would leave an empty list under a strip with nothing lit. Only on
     a tab change: the lists themselves keep loading, and a keymode arriving
     late must not take a pick away from whoever just made it. */
  useEffect(() => {
    setKeyFilter((current) => (current === "all" || availableKeyModes.includes(current) ? current : "all"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);
  const displayedProfileInsights = profileInsights;
  const cachedAboutFallback = user ? readCachedPlayerAbout(user.id) : undefined;
  const displayedAboutHtml = aboutHtml ?? cachedAboutFallback?.html;
  const displayedAboutRaw = aboutRaw ?? cachedAboutFallback?.raw ?? null;
  const displayedAboutOwn = aboutOwn || (aboutHtml == null && cachedAboutFallback?.own === true);
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

  const currentScores = tab === "best" ? shownBest : shownRecent;
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
     same order and under one ranking, and the list is built even when there
     are none to join. "All" is left alone: there the window is exactly what
     osu! ranks, and 200 more rows under it would be a different list wearing
     the same name. */
  /* The keymode's list itself: window plays and tracked ones under one pp
     ranking, cut at the same 200 the Key Split modal's total is built from.
     Ranked and cut before the mod filter, so filtering narrows the list rather
     than pulling in the 201st play to backfill it, and so the two numbers on
     screen describe the same set of plays. */
  const keymodeListRows: BestListRow[] | null = tab === "best" && keyFilter !== "all"
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
  // Navigation first renders without a user. Keep both rating hooks above
  // the loading/error returns so the resolved snapshot cannot add hooks.
  const showRecentRatings = useRecentPlayRatings() && tab === "recent";
  const recentRatings = useRecentPlayRatingLookup(
    user?.id,
    showRecentRatings ? visibleRows.flatMap((row) => (row.kind === "score" ? [row.score] : [])) : [],
    showRecentRatings,
  );

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
  /* A keymode's rows are numbered within that keymode's own list, whether or
     not tracked plays joined it: a window play's place in the profile-wide top
     200 would read as a different scale from the tracked row beside it, and it
     would make the same list start at 1 for one keymode and at 135 for another
     purely on whether a tail existed. */
  const keymodeListPositions = new Map<string, number>();
  if (keymodeListRows) {
    keymodeListRows.forEach((row, index) => {
      keymodeListPositions.set(bestListRowKey(row), index + 1);
    });
  }
  const loadingBest = restrictedPpPending || (shownBest.length === 0 && !bestWindowLoaded && !bestError);
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
    !storedProfileHidden &&
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

  // A player osu! no longer returns has no avatar_url; show osu!'s own guest
  // avatar rather than a broken image.
  const avatarSrc = user.avatar_url || GUEST_AVATAR_URL;
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
  const hasTabControls = tab === "recent" || (tab === "best" && bestWindowLoaded && shownBest.length > 0);
  const ppVariants = (stats.variants ?? [])
    .filter((variant) => variant.mode === "mania" && variant.pp > 0)
    .sort((a, b) => a.variant.localeCompare(b.variant));
  // A stand-in standing takes osu!'s place in the headline numbers, and the
  // 90-day trend and per-keymode pp under them describe numbers no longer shown.
  const shownGlobalRank = restrictedStanding ? restrictedStanding.globalRank : stats.global_rank;
  const shownCountryRank = restrictedStanding ? restrictedStanding.countryRank : stats.country_rank;
  const shownPp = restrictedStanding ? restrictedStanding.pp : stats.pp;
  const railTotals = profileRailTotals(stats, restrictedStanding, profileStatsProjectedOnly);
  const heroValueSkeleton = <span className="skeleton-pulse block h-[26px] w-24 rounded sm:h-[34px] sm:w-32" />;

  // osu! 404s a restricted or missing account, so its profile link would too.
  // A frozen account's owner can name their profile (DisplayNameEditor).
  const canRename = !!user.account_status && auth.viewer?.id === user.id;
  // Any player can link their private server profiles (ServerLinks).
  const canLinkServers = auth.viewer?.id === user.id;
  const serverLinkMeta: ReactNode[] = [
    ...(user.server_links ?? []).map((link) => <ServerLinkPill key={`server-${link.server}`} link={link} />),
    ...(canLinkServers ? [
      <ServerLinksButton
        key="server-links"
        links={user.server_links ?? []}
        onSaved={(links) => {
          playerSnapshotDataCache.clear();
          userDataCache.clear();
          setUser((current) => {
            if (!current) return current;
            const { server_links: _previous, ...rest } = current;
            return links.length ? { ...rest, server_links: links } : rest;
          });
        }}
      />,
    ] : []),
  ];
  // The same owner can replace their frozen About page (own-about.ts).
  const saveOwnAbout = async (raw: string): Promise<string | null> => {
    const result = await setMyOwnAbout({ data: { raw } }).catch(() => null);
    if (!result?.ok) {
      return result?.error === "too_long"
        ? t`The page is over osu!'s 60,000 character limit.`
        : t`Couldn't save your page right now.`;
    }
    playerAboutDataCache.delete(user.id);
    setAboutHtml(null);
    setAboutRaw(result.raw);
    setAboutOwn(result.raw != null);
    setAboutEditing(false);
    return null;
  };
  const heroMeta: ReactNode[] = user.account_status ? [
    <span key="status" className="rounded-full bg-osu-red/20 px-2 py-0.5 font-semibold text-osu-red-light">
      {user.account_status === "restricted" ? <Trans>Restricted on osu!</Trans> : <Trans>Not on osu! anymore</Trans>}
    </span>,
    ...serverLinkMeta,
    // A display name is the player's own label; the osu! name stays in view
    // so it can never pass for someone else's.
    ...(user.display_name ? [
      <span key="osu-name"><Trans>osu! name {user.username}</Trans></span>,
    ] : []),
    ...(canRename ? [
      <DisplayNameButton
        key="rename"
        nextChangeAt={pendingRenameDate(user.display_name_next_change_at)}
        open={renameOpen}
        onOpen={() => setRenameOpen(true)}
      />,
    ] : []),
  ] : [
    ...(user.team ? [
      <Link
        key="team"
        to="/team/$teamId"
        params={{ teamId: String(user.team.id) }}
        title={user.team.short_name}
        className="inline-flex min-w-0 items-center gap-1.5 text-[12px] font-semibold text-white/85 transition-colors duration-150 hover:text-white"
      >
        {user.team.flag_url ? (
          // osu! team flags are 2:1.
          <img src={user.team.flag_url} alt="" className="h-4 w-8 shrink-0 rounded-[3px] object-cover ring-1 ring-white/20" />
        ) : null}
        <span className="max-w-[16rem] truncate">{user.team.name}</span>
      </Link>,
    ] : []),
    <a
      key="osu"
      href={`https://osu.ppy.sh/users/${user.id}/mania`}
      target="_blank"
      rel="noreferrer"
      // Same shape as the private server pills beside it (ServerLinkPill).
      className="inline-flex items-center gap-1.5 rounded-full bg-white/10 py-0.5 pl-0.5 pr-2 font-semibold text-white/80 transition-colors duration-150 hover:bg-white/20 hover:text-white"
    >
      <span className="h-4 w-4 rounded-full bg-osu-pink text-white">
        <OsuLogo className="h-4 w-4" />
      </span>
      <Trans>osu! profile</Trans>
    </a>,
    ...serverLinkMeta,
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
          <ModUsageModal insights={profileInsights} onClose={() => setModModalOpen(false)} />
        )}
      </AnimatePresence>

      {/* BPM breakdown modal */}
      <AnimatePresence>
        {bpmModalOpen && profileInsights && profileInsights.medianBpm != null && (
          <BpmBreakdownModal insights={profileInsights} onClose={() => setBpmModalOpen(false)} />
        )}
      </AnimatePresence>

      {/* PP distribution modal */}
      <AnimatePresence>
        {ppModalOpen && profileInsights?.ppRange && profileInsights.ppDistribution.length > 0 && (
          <PpDistributionModal insights={profileInsights} scores={shownBest} onClose={() => setPpModalOpen(false)} />
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
          <ScoreDetailModal
            score={detailScore}
            onClose={() => setDetailScore(null)}
          />
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
                <UsernameText username={user.display_name ?? user.username} avatarUrl={user.avatar_url} className="min-w-0 truncate p-2 -m-2 text-[26px] font-black leading-none text-white sm:text-[40px]" />
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
              {canRename && renameOpen ? (
                <DisplayNameForm
                  current={user.display_name ?? null}
                  osuName={user.username}
                  onClose={() => setRenameOpen(false)}
                  onSaved={(displayName, nextChangeAt) => {
                    // Cached snapshots still carry the old name; the next visit refetches.
                    playerSnapshotDataCache.clear();
                    userDataCache.clear();
                    setUser((current) => {
                      if (!current) return current;
                      const { display_name: _previous, ...rest } = current;
                      return {
                        ...rest,
                        ...(displayName ? { display_name: displayName } : {}),
                        display_name_next_change_at: nextChangeAt,
                      };
                    });
                  }}
                />
              ) : null}
            </div>
          </div>

          {/* The keycap easter egg stands on the rail below and leans into this
              corner, so on narrow screens the numbers step out of its way. */}
          <div className={`mt-7 grid grid-cols-2 gap-x-6 gap-y-5 sm:mt-9 sm:flex sm:flex-wrap sm:items-end sm:gap-x-12 sm:pr-0 ${showTungTungSahur ? "pr-16" : ""}`}>
            <HeroStat
              label={t`Global`}
              value={restrictedPpPending ? heroValueSkeleton : shownGlobalRank ? `#${formatNumber(shownGlobalRank)}` : "-"}
              sub={!storedProfileHidden && rankDelta90d != null && rankDelta90d !== 0 ? (
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
              value={restrictedPpPending ? heroValueSkeleton : shownCountryRank ? `#${formatNumber(shownCountryRank)}` : "-"}
              valueClassName="text-osu-pink-light"
              sub={profileCountryName ?? (user.country_code || null)}
            />
            <HeroStat
              label={t`Peak`}
              value={awaitingPeak ? heroValueSkeleton : peakRank ? `#${formatNumber(peakRank)}` : "-"}
              valueClassName={peakRank ? getRankTierClass(peakRank) || "text-white" : "text-white"}
              sub={peakRank && peakRankDate ? t`achieved ${formatDate(peakRankDate)}` : null}
            />
            <HeroStat
              label={t`Performance`}
              value={restrictedPpPending ? heroValueSkeleton : `${formatNumber(Math.round(shownPp))}pp`}
              valueClassName="text-osu-yellow"
              sub={!storedProfileHidden && ppVariants.length >= 2 ? (
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
            <RailStat
              label={t`Accuracy`}
              value={restrictedPpPending
                ? <Skeleton className="h-[19px] w-16" />
                : restrictedStanding
                  ? restrictedStanding.rankedPlays > 0 ? formatAccuracy(restrictedStanding.accuracy) : "-"
                  : profileStatsProjectedOnly ? "-" : formatAccuracy(stats.hit_accuracy / 100)}
            />
            <RailStat
              label={t`Play Count`}
              value={restrictedPpPending ? <Skeleton className="h-[19px] w-12" /> : railTotals.playCount == null ? "-" : formatNumber(railTotals.playCount)}
            />
            <RailStat
              label={t`Play Time`}
              value={restrictedPpPending
                ? <Skeleton className="h-[19px] w-10" />
                : railTotals.playTime == null ? "-" : t`${formatNumber(Math.floor(railTotals.playTime / 3600))}h`}
            />
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
                ["SSH", railTotals.gradeCounts?.ssh],
                ["SS", railTotals.gradeCounts?.ss],
                ["SH", railTotals.gradeCounts?.sh],
                ["S", railTotals.gradeCounts?.s],
                ["A", railTotals.gradeCounts?.a],
              ] as [string, number | undefined][]).map(([grade, count]) => (
                <div key={grade} className="flex items-center gap-1.5">
                  <GradeImg grade={grade} size={26} />
                  <span className="text-xs font-semibold tabular-nums text-osu-f1">{count == null ? "-" : formatNumber(count)}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Profile insights */}
          <div className="py-5">
            {loadingInsights || restrictedPpPending ? (
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
                    onPointerEnter={playerTab === "card" ? preloadManiaCard3DPanel : undefined}
                    onFocus={playerTab === "card" ? preloadManiaCard3DPanel : undefined}
                    onPointerDown={playerTab === "card" ? preloadManiaCard3DPanel : undefined}
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
              <div className="hidden min-w-0 items-center gap-2 lg:flex">
                {tab === "recent" && !user.account_status && (
                  <RecentOsuSourceButton
                    loading={loadingOsuRecent}
                    loaded={recentOsuLoaded}
                    fetchedAt={recentOsuFetchedAt}
                    onFetch={handleFetchOsuRecent}
                  />
                )}
                {tab === "recent" && user.account_status && (
                  <RecentRefreshButton loading={refreshingImports} onRefresh={handleRefreshImports} />
                )}
                {availableKeyModes.length > 1 && (
                  /* Recent's overflow opens the rest of the strip in place, not
                     the PP by Keymode modal: that modal only knows keymodes that
                     earned pp, so a keymode played only on unranked maps would
                     have no way to be filtered to. */
                  <KeyModeControl
                    availableKeyModes={availableKeyModes}
                    keyFilter={keyFilter}
                    onChangeKeyFilter={setKeyFilter}
                    maxVisible={MAX_INLINE_KEY_MODES_WIDE}
                    playCounts={tab === "recent" ? recentKeyModePlayCounts : keyModePlayCounts}
                    onOverflow={tab === "recent" ? undefined : keyModeOverflowHandler}
                  />
                )}
              </div>
            )}
          </div>

          {tab === "best" && bestWindowLoaded && shownBest.length > 0 && (
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
              {user.account_status ? (
                <RecentRefreshButton loading={refreshingImports} onRefresh={handleRefreshImports} />
              ) : (
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
                  maxVisible={MAX_INLINE_KEY_MODES}
                  playCounts={recentKeyModePlayCounts}
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
                      onSave={canRename ? saveOwnAbout : undefined}
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
                ) : displayedAboutOwn && displayedAboutRaw ? (
                  <OwnAboutCard raw={displayedAboutRaw} onEdit={() => setAboutEditing(true)} />
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
                        showRating={showRecentRatings}
                        rating={showRecentRatings ? recentRatings.get(recentPlayRatingKey(row.score)) : undefined}
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

/* The height the Skills panel last stood at, module-level on purpose: the
   collapse it exists to prevent happens across an UNMOUNT (leaving the tab and
   coming back), so a floor kept in component state would be gone exactly when
   it is needed. One number for the whole app, because only one profile's
   Skills panel is ever on screen. */
let lastSkillsPanelHeight: number | null = null;

// What the public Skills tab is showing: its published ratings, or one of the
// two bounded plays lists behind them.
type PlayerSkillsView = "ratings" | SkillPlaysExplorerView;

const PLAYER_SKILLS_VIEWS: PlayerSkillsView[] = ["ratings", "msd", "dan", "unrated"];

function getPlayerSkillsViewLabelMsg(view: PlayerSkillsView): MessageDescriptor {
  if (view === "msd") return msg`MSD plays`;
  if (view === "dan") return msg`Dan plays`;
  if (view === "unrated") return msg`Unrated plays`;
  return msg`Ratings`;
}

// Public Skills tab: the exact per-keymode skill ratings (same renderer as the
// My Data card) with population percentiles and player dan chips. First-time
// visitors start "pending" while the backend rates their plays, so the panel
// polls until the breakdown lands.
/* The ratings view is one column: the keymode strip, the open panel and the
   add-a-score row all share this width and centre together on a wide screen.
   The plays views stay full width - they are lists, not a card. */
const SKILLS_COLUMN_CLASS = "mx-auto max-w-[880px]";

function PlayerSkillsPanel({ user }: { user: OsuUser }) {
  const { t, i18n } = useLingui();
  const auth = useAuth();
  const noDans = useNoDans();
  const [skillsView, setSkillsView] = useState<PlayerSkillsView>("ratings");
  /* Swapping the ratings grid for a plays list that has not loaded yet takes
     a thousand pixels out of the document for as long as the read takes. The
     browser clamps the scroll offset to the shorter page, so a reader deep in
     the tab is thrown back up to the header and then left there when the rows
     land. The panel holds the height it had until the incoming view has
     something in it, which is a floor, not a fixed size: the new view is free
     to be taller, and a genuinely shorter one settles into place once rather
     than after a jump. */
  const [heldHeight, setHeldHeight] = useState<number | null>(() => lastSkillsPanelHeight);
  const panelRef = useRef<HTMLDivElement | null>(null);

  /* Recorded continuously rather than on unmount: a cleanup cannot read a
     height off an element React is in the middle of detaching. */
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      const height = panel.getBoundingClientRect().height;
      if (height > 0) lastSkillsPanelHeight = height;
    });
    observer.observe(panel);
    return () => observer.disconnect();
  }, []);
  const [skills, setSkills] = useState<LivePlayerSkills | null>(null);
  const [skillsError, setSkillsError] = useState(false);
  const [selectedSkill, setSelectedSkill] = useState<{ entry: SkillAxisEntry; keyCount: number } | null>(null);
  const [selectedDan, setSelectedDan] = useState<{ side: "rc" | "ln"; keyCount: number } | null>(null);
  /* Which keymode the open panel is for; null follows the profile's own main. */
  const [skillModeKey, setSkillModeKey] = useState<number | null>(null);
  /* The run behind a course-floored dan, shown on the same card a tracked play
     opens. Built here rather than in the window because the card belongs to the
     profile and the play is by the profile's owner. */
  const [courseScore, setCourseScore] = useState<OsuScore | null>(null);
  const [addScoreOpen, setAddScoreOpen] = useState(false);
  // Bumped when a manual submission stores a score, so an already-ready panel
  // refetches (which also re-arms the pending poll) instead of staying stale
  // until a remount.
  const [skillsRefreshKey, setSkillsRefreshKey] = useState(0);
  const liveConfigured = isLiveBackendConfigured();
  /* osu! turned this account away, so its ratings come from its Companella
     imports alone: no osu! score can be added, and tracking says nothing. */
  const restricted = !!user.account_status;

  const addScoreButton = restricted ? null : (
    <button
      type="button"
      onClick={() => setAddScoreOpen(true)}
      className="inline-flex items-center gap-1.5 rounded-full bg-osu-b4 px-3 py-1 text-[11.5px] font-semibold text-osu-l2 transition-colors cursor-pointer hover:bg-osu-b3/60 hover:text-white"
    >
      <Plus className="h-3.5 w-3.5" aria-hidden="true" />
      <Trans>Add a missing score</Trans>
    </button>
  );
  const addScoreModal = addScoreOpen && !restricted
    ? (
      <AddScoreModal
        userId={user.id}
        username={user.username}
        onClose={() => setAddScoreOpen(false)}
        onSubmitted={() => setSkillsRefreshKey((key) => key + 1)}
      />
    )
    : null;
  const addScoreRow = addScoreButton ? <div className="mt-3 flex justify-end">{addScoreButton}</div> : null;

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
        // Poll while pending, and after a manual score submission also while
        // ready-but-stale: the recompute the submission queued lands minutes
        // later, and a ready answer would otherwise stop the refresh here.
        // Ordinary views ignore the stale flag on purpose - most active
        // players' rows are mildly stale, and 40 polls per profile open is a
        // real cost.
        const awaitingRecompute = data.status === "pending" || (skillsRefreshKey > 0 && data.status === "ready" && data.stale === true);
        if (awaitingRecompute && attempts < 40) {
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
  }, [user.id, liveConfigured, skillsRefreshKey]);

  useEffect(() => {
    setSelectedSkill(null);
    setSkillModeKey(null);
  }, [user.id]);

  useEffect(() => {
    if (!noDans) return;
    setSkillsView((current) => current === "dan" ? "ratings" : current);
    setSelectedDan(null);
    setCourseScore(null);
  }, [noDans]);

  const modes = qualifyingSkillModes(skills);
  /* `modes` arrives ranked by rated plays, most first, and the strip keeps
     that order: the keymode someone plays leads, and its panel is the one that
     opens. Keycount order would put a profile's 4K first whether they play it
     or not. */
  const skillModeStrip = modes;
  const activeSkillMode = modes.find((mode) => mode.keyCount === skillModeKey) ?? modes[0] ?? null;
  const view = noDans && skillsView === "dan" ? "ratings" : skillsView;
  const skillsViews = PLAYER_SKILLS_VIEWS.filter((option) => !noDans || option !== "dan");

  const selectView = useCallback((next: PlayerSkillsView) => {
    if (next === skillsView) return;
    setHeldHeight(panelRef.current?.getBoundingClientRect().height ?? null);
    setSkillsView(next);
  }, [skillsView]);

  /* The ratings view releases the floor itself, one frame after it has an
     answer to draw. Waiting for the answer is the point: on a fresh mount the
     breakdown is still in flight, and releasing on the first frame would drop
     the floor onto the loading skeleton, which is the collapse all over again.
     An error releases too, since a failed read is as final as a good one.
     The two plays lists release through onListSettled instead. */
  useEffect(() => {
    if (heldHeight == null || view !== "ratings") return;
    if (skills == null && !skillsError) return;
    const frame = requestAnimationFrame(() => setHeldHeight(null));
    return () => cancelAnimationFrame(frame);
  }, [heldHeight, skills, skillsError, view]);

  const releaseHeldHeight = useCallback(() => setHeldHeight(null), []);

  if (!liveConfigured) {
    return <div className="py-8 text-center text-sm text-osu-f1">{t`Skill ratings are unavailable right now.`}</div>;
  }

  /* Every state of the panel is one tree, not a return each: a submission
     queues a recompute that can flip the panel between them while the dialog
     is open, and a second mount point would tear the dialog down mid-paste. */
  const rated = skills != null && skills.status === "ready" && modes.length > 0;
  /* Said before anything is read, in every view: a reader who lands here
     looking for a loved or graveyard play would otherwise take its absence
     for a bug. Older backends omit the flag, and then nothing is claimed. */
  const untrackedNote = skills?.tracked === false && !restricted ? (
    <div className={`mb-4 ${view === "ratings" || !rated ? SKILLS_COLUMN_CLASS : ""}`}>
      <SkillsUntrackedNotice
        username={user.username}
        isOwner={auth.viewer?.id === user.id}
        onTracked={() => setSkillsRefreshKey((key) => key + 1)}
      />
    </div>
  ) : null;
  return (
    <div ref={panelRef} style={heldHeight != null ? { minHeight: heldHeight } : undefined}>
      <SharedSkillPlay userId={user.id} username={user.username} />
      {untrackedNote}
      {rated ? (
        /* Pinned to the page edge on every view: the ratings column below is
           centred and the plays views are full width, and a switch that
           followed either would jump sideways on each click. */
        <div className="mb-3 flex">
          {/* One track, the same object as the keymode and order controls
              below it, so the row reads as a switch and not four loose buttons. */}
          <Segmented
            ariaLabel={t`View`}
            value={view}
            options={skillsViews.map((option) => ({
              value: option,
              label: i18n._(getPlayerSkillsViewLabelMsg(option)),
              onPrefetch: option === "ratings" ? undefined : () => prefetchSkillPlaysExplorerView(user.id, modes, option),
            }))}
            onChange={selectView}
            shape="tabs"
          />
        </div>
      ) : null}
      {skillsError ? (
        <div className="py-8 text-center text-sm text-osu-f1">{t`Could not load skill ratings. Try again in a bit.`}</div>
      ) : !skills ? (
        /* Shaped like what lands: a keymode strip over one panel, not the
           two-panel grid the tab used to open with. */
        <div>
          {/* The view switch lands first, at the size of its four labels. */}
          <Skeleton className="mb-3 h-[30px] w-[340px] max-w-full rounded-lg" />
          <div className={SKILLS_COLUMN_CLASS}>
            <div className="mb-4 flex flex-wrap gap-x-7 gap-y-3">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="space-y-1">
                  <Skeleton className="h-2.5 w-6" />
                  <Skeleton className="h-5 w-14" />
                </div>
              ))}
            </div>
            <div className="space-y-3 rounded-xl border border-osu-b3/20 bg-osu-b4 p-4">
              <Skeleton className="h-3 w-16" />
              <Skeleton className="h-7 w-24" />
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-3 w-full" />
              ))}
            </div>
          </div>
        </div>
      ) : rated && view !== "ratings" ? (
        <SkillPlaysExplorer
          userId={user.id}
          username={user.username}
          modes={modes}
          view={view}
          onListSettled={releaseHeldHeight}
        />
      ) : rated ? (
        /* One column, strip and panel the same width: a page-wide strip over a
           half-width panel read as a layout that had lost its other half. */
        <div className={SKILLS_COLUMN_CLASS}>
          {/* Every keymode at one size: a keymode is not worth less because
              it is played less, and MinaCalc rating 4K-18K means a profile can
              hold nine of them. The strip carries each rating, so it reads as
              the whole answer and the panel below is the one being looked
              at. */}
          {skillModeStrip.length > 1 ? (
            <div className="mb-4 flex flex-wrap gap-x-7 gap-y-3">
              {skillModeStrip.map((mode) => (
                <SkillModeOption
                  key={mode.keyCount}
                  mode={mode}
                  selected={mode.keyCount === activeSkillMode?.keyCount}
                  onSelect={() => setSkillModeKey(mode.keyCount)}
                />
              ))}
            </div>
          ) : null}
          {/* Height reserve. Every keymode's panel is mounted into one grid
              cell with all but the open one `invisible`, so the cell is always
              as tall as the tallest panel and switching keymode cannot change
              the page height - a 4K panel with a radar and seven axes is twice
              a 5K panel with two rows, and swapping between them shrank the
              document under the reader and threw their scroll position back up
              the page. `invisible` keeps the hidden ones out of the tab order
              while still reserving their height.

              The open panel keeps its natural height (`items-start`) and the
              add-a-score row rides in the same cell beneath it, so the slack
              lands at the bottom of the tab as plain page background rather
              than as empty space inside the card or a stranded button. */}
          <div className="grid grid-cols-1 items-start">
            {skillModeStrip.filter((mode) => mode.keyCount !== activeSkillMode?.keyCount).map((mode) => (
              <div key={mode.keyCount} className="invisible col-start-1 row-start-1" aria-hidden>
                <SkillModePanel skills={skills} mode={mode} userId={user.id} />
                {/* The reserve measures what the open cell measures, button
                    row included, or picking the tallest keymode would still
                    move the page by exactly this row. */}
                {addScoreRow}
              </div>
            ))}
            {activeSkillMode ? (
              <div className="col-start-1 row-start-1">
                <SkillModePanel
                  skills={skills}
                  mode={activeSkillMode}
                  userId={user.id}
                  onSelectEntry={(entry) => setSelectedSkill({ entry, keyCount: activeSkillMode.keyCount })}
                  onSelectDan={(side) => setSelectedDan({ side, keyCount: activeSkillMode.keyCount })}
                />
                {addScoreRow}
              </div>
            ) : null}
          </div>
        </div>
      ) : (
        <div className="mx-auto max-w-[440px]">
          <PlayerSkillCard title={t`Skill rating`} accent={skillRatingAccent(null)}>
            <SkillBreakdownBody skills={skills} mode={null} />
          </PlayerSkillCard>
        </div>
      )}
      {/* A profile with nothing rated yet is exactly who has scores to
          backfill, so the button rides that state too - but not the states
          where there is nothing to read yet. The ratings view draws its own
          inside the height reserve, so it is excluded here. */}
      {addScoreButton && skills && !skillsError && !(rated && view === "ratings") ? (
        <div className={`mt-3 flex ${rated ? "justify-end" : "justify-center"}`}>{addScoreButton}</div>
      ) : null}
      {addScoreModal}
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
      {selectedDan && !noDans ? (
        <DanEvidenceModal
          userId={user.id}
          username={user.username}
          keyCount={selectedDan.keyCount}
          side={selectedDan.side}
          onClose={() => setSelectedDan(null)}
          onOpenCourseScore={(course) => setCourseScore(buildTrackedPlayScore({
            beatmapId: course.beatmapId,
            keyCount: selectedDan.keyCount,
            // A dan course is loved or graveyard, so the run is worth no pp;
            // the card reads it as a tracked play, which is what it is.
            pp: 0,
            beatmapsetId: course.beatmapsetId,
            title: course.title,
            artist: course.artist,
            version: course.version,
            // The card is a score card, so it shows the accuracy the player's
            // own client did. The ladder's number is the window's business.
            accuracy: course.displayedAccuracy ?? course.accuracy,
            rank: course.rank,
            mods: course.mods,
            playedAt: course.playedAt,
            maxCombo: course.maxCombo,
            hasReplay: course.hasReplay,
            soloScoreId: course.soloScoreId,
            totalScore: course.totalScore,
            legacyScoreId: course.legacyScoreId,
            isLazer: course.isLazer,
            statistics: course.statistics,
            creator: null,
            stars: null,
            bpm: null,
          }, {
            id: user.id,
            username: user.username,
            avatar_url: user.avatar_url,
            country_code: user.country_code,
          }))}
        />
      ) : null}
      {courseScore ? (
        <ScoreDetailModal score={courseScore} onClose={() => setCourseScore(null)} />
      ) : null}
    </div>
  );
}

function OwnAboutCard({ raw, onEdit }: { raw: string; onEdit: () => void }) {
  const { t } = useLingui();
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
      <div className="bbcode-content bbcode-content--capped px-4 py-3 text-sm text-osu-l2 max-h-[520px] overflow-y-auto">
        <BBCodePreview source={raw} />
      </div>
    </div>
  );
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

function RecentRefreshButton({ loading, onRefresh }: { loading: boolean; onRefresh: () => void }) {
  const { t } = useLingui();
  // The read usually lands in a few milliseconds, so the icon spins for a
  // moment on every press regardless, as the Skills plays refresh does.
  const [spinning, setSpinning] = useState(false);
  const spinTimerRef = useRef<number | null>(null);
  useEffect(() => () => {
    if (spinTimerRef.current != null) window.clearTimeout(spinTimerRef.current);
  }, []);
  const press = () => {
    setSpinning(true);
    if (spinTimerRef.current != null) window.clearTimeout(spinTimerRef.current);
    spinTimerRef.current = window.setTimeout(() => {
      spinTimerRef.current = null;
      setSpinning(false);
    }, 700);
    onRefresh();
  };
  return (
    <button
      type="button"
      onClick={press}
      title={t`Refresh`}
      aria-label={t`Refresh`}
      className="inline-flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-lg border border-osu-b3/25 bg-osu-b4/55 text-osu-f1 transition-colors hover:text-osu-l1"
    >
      <RefreshCw size={12} className={spinning || loading ? "animate-spin" : ""} />
    </button>
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

// A stat on the flat rail under the hero: quiet label, the number carrying the
// weight. No box, the rail's hairline does the separating.
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

// A keymode total counts only what the top-200 window still holds, so mark it
// as a floor once the plays below the cutoff could move it by more than this.
const KEY_PP_FLOOR_RATIO = 0.02;

function isKeyPpFloor(bucket: UserProfileInsights["keyPp"][number]): boolean {
  return bucket.missingBound > bucket.weightedPp * KEY_PP_FLOOR_RATIO;
}
