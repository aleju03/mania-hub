import { createFileRoute, stripSearchParams, useNavigate } from "@tanstack/react-router";
import { useState, useEffect, useCallback, useMemo, memo, useRef, type ReactNode } from "react";
import { useWindowVirtualizer } from "@tanstack/react-virtual";
import { getCountryName, isGlobalScope } from "../lib/country";
import { isRegionScope } from "../lib/regions";
import { formatAccuracy, formatTimeAgo, formatPP, formatNumber, formatPpGain } from "../lib/format";
import {
  getBeatmapUrl,
  getBeatmapKeyCount,
  getBeatmapKeymodeLabel,
  getDisplayedAccuracy,
  getDisplayedRank,
  getDisplayedTotalScore,
  getModDisplayList,
  getScoreIdentity,
  getScoreTimeMs,
  getScoreTimestamp,
  getScoreUrl,
  isDisplayedPassed,
  isLazerScore,
  scoreHasReplay,
} from "../lib/score";
import { PageHeader } from "../components/layout/PageHeader";
import { OsuTriangleBackdrop } from "../components/layout/OsuTriangleBackdrop";
import { CountryFlag } from "../components/ui/CountryFlag";

import { Avatar } from "../components/ui/Avatar";
import { GradeImg } from "../components/ui/GradeImg";
import { FilterField, SegmentedControl } from "../components/ui/SegmentedControl";
import { ModBadge } from "../components/ui/ModBadge";
import { DanBadge } from "../components/ui/DanBadge";
import { StarRatingBadge } from "../components/ui/StarRating";
import { TrackerRowSkeleton } from "../components/ui/LoadingSkeleton";
import { Pagination } from "../components/ui/Pagination";
import { getManiaJudgementStats } from "../components/ui/ManiaJudgementStats";
import { UsernameText } from "../components/ui/UsernameText";
import { CoverBackdrop } from "../components/ui/CoverBackdrop";
import { TRACKER_FEED_SCORE_LIMIT, TRACKER_PP_GAIN_CLIENT_TTL, useAppStore, useHiddenUserIds, useSelectedCountry } from "../store";
import type { LeanTrackerScore } from "../lib/types";
import { parseCountrySearchParam } from "../lib/country-search";
import { getReplaySearch } from "../lib/replay-navigation";
import { showPlayerCountryFlagState } from "../lib/player-profile-navigation";
import { seedPlayerRecentPlay } from "../lib/player-shell-cache";
import { fetchLiveTrackerSnapshot, isLiveBackendConfigured, openLiveEventSource } from "../lib/live-backend";
import { detectTrackerMultis, type TrackerMultiRound } from "../lib/tracker-multi";
import { CountryWarming } from "../components/CountryWarming";
import { LiveBackendRequired, LiveDataEmptyState } from "../components/LiveDataEmptyState";
import { useCountryWarming } from "../lib/use-country-warming";
import { useWindowActive } from "../lib/window-activity";

const TRACKER_PAGE_SIZE = 45;
const TRACKER_LIVE_MIN_SNAPSHOT_LIMIT = TRACKER_PAGE_SIZE * 2;
// Global ingest normally lands scores every few seconds across all tracked
// countries; several silent minutes means the pipeline is stalled, not quiet.
const TRACKER_INGEST_DELAYED_AFTER_MS = 3 * 60_000;
const TRACKER_LIVE_RECONCILE_LIMIT = 60;
const TRACKER_LIVE_RECONCILE_MIN_INTERVAL_MS = 2 * 60_000;
const TRACKER_GLOBAL_WINDOW_HOURS = 24;
const DEV_ACTIVE_PLAYER_SIMULATION_COUNT = 200;

type ActivePlayerRailInfo = {
  username: string;
  avatar_url: string;
  latestTime: number;
  simulated?: boolean;
};

type ActivePlayerRailItem = ActivePlayerRailInfo & {
  id: number;
};

function makeDevAvatarUrl(index: number): string {
  const hue = (index * 47) % 360;
  const accentHue = (hue + 44) % 360;
  const label = String((index % 99) + 1);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="32" fill="hsl(${hue} 58% 28%)"/><circle cx="45" cy="18" r="20" fill="hsl(${accentHue} 90% 66%)" opacity=".75"/><circle cx="20" cy="46" r="22" fill="hsl(${hue} 78% 72%)" opacity=".62"/><text x="32" y="38" text-anchor="middle" font-family="Arial,sans-serif" font-size="20" font-weight="700" fill="white">${label}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function makeDevActivePlayers(count: number): ActivePlayerRailItem[] {
  const now = Date.now();
  return Array.from({ length: count }, (_, index) => ({
    id: -9_000_000 - index,
    username: `sim player ${index + 1}`,
    avatar_url: makeDevAvatarUrl(index),
    latestTime: now - index * 1000,
    simulated: true,
  }));
}

// Dev-only feed simulation: streams synthetic tracker scores (solo plays plus
// multiplayer-lobby rounds where several players finish the same map within
// seconds) so the feed UI, entrance animation, and MULTI badge can be
// eyeballed without waiting for real activity.
const DEV_FEED_SIM_INTERVAL_MS = 2_500;
const DEV_FEED_SIM_MAX_SCORES = 120;
const DEV_FEED_SIM_LOBBY_CHANCE = 0.45;
const DEV_FEED_SIM_USER_COUNT = 10;

type DevSimUser = LeanTrackerScore["user"];

type DevSimMap = {
  beatmapId: number;
  beatmapsetId: number;
  title: string;
  artist: string;
  version: string;
  keys: number;
  stars: number;
  bpm: number;
  noteCount: number;
};

function makeDevCoverUrl(index: number): string {
  const hue = (index * 61) % 360;
  const accentHue = (hue + 150) % 360;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 140"><rect width="400" height="140" fill="hsl(${hue} 45% 22%)"/><polygon points="60,140 160,0 260,140" fill="hsl(${accentHue} 70% 55%)" opacity=".35"/><polygon points="200,140 320,0 400,90 400,140" fill="hsl(${hue} 70% 60%)" opacity=".3"/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

const DEV_SIM_MAPS: DevSimMap[] = [
  { beatmapId: -101, beatmapsetId: -11, title: "Sidereal Cascade", artist: "monoq", version: "4K Insane", keys: 4, stars: 4.6, bpm: 185, noteCount: 2350 },
  { beatmapId: -102, beatmapsetId: -12, title: "paperclip waltz", artist: "Feryquitous", version: "4K Another", keys: 4, stars: 5.3, bpm: 202, noteCount: 3120 },
  { beatmapId: -103, beatmapsetId: -13, title: "Overclock City", artist: "t+pazolite", version: "4K Hyper", keys: 4, stars: 3.8, bpm: 220, noteCount: 1840 },
  { beatmapId: -104, beatmapsetId: -14, title: "Lantern Route", artist: "Frums", version: "7K Extra", keys: 7, stars: 5.0, bpm: 174, noteCount: 4010 },
  { beatmapId: -105, beatmapsetId: -15, title: "Glass Meridian", artist: "ARForest", version: "4K Expert", keys: 4, stars: 4.2, bpm: 190, noteCount: 2680 },
  { beatmapId: -106, beatmapsetId: -16, title: "Nocturne 9", artist: "Sound Souler", version: "7K Insane", keys: 7, stars: 4.4, bpm: 160, noteCount: 3350 },
  { beatmapId: -107, beatmapsetId: -17, title: "Runaway Comet", artist: "II-L", version: "4K Lunatic", keys: 4, stars: 6.1, bpm: 240, noteCount: 3560 },
  { beatmapId: -108, beatmapsetId: -18, title: "Terminal Bloom", artist: "Se-U-Ra", version: "4K Normal", keys: 4, stars: 2.4, bpm: 145, noteCount: 980 },
];

// Negative ids: getScoreUrl returns null (no dead osu! links) and
// getScoreIdentity falls back to its composite key, which stays unique
// per simulated play.
let devSimNextScoreId = -8_000_000_000;

function makeDevSimUsers(count: number): DevSimUser[] {
  return Array.from({ length: count }, (_, index) => ({
    id: -9_500_000 - index,
    username: `sim player ${index + 1}`,
    avatar_url: makeDevAvatarUrl(index),
    country_code: "CR",
  }));
}

function makeDevSimScore(user: DevSimUser, map: DevSimMap, modAcronyms: string[], endedAtMs: number): LeanTrackerScore {
  const total = map.noteCount;
  const miss = Math.round(total * Math.random() * 0.015);
  const meh = Math.round(total * Math.random() * 0.003);
  const ok = Math.round(total * Math.random() * 0.008);
  const good = Math.round(total * Math.random() * 0.025);
  const rest = Math.max(0, total - miss - meh - ok - good);
  const perfect = Math.round(rest * (0.55 + Math.random() * 0.4));
  const great = rest - perfect;
  const accuracy = (300 * (perfect + great) + 200 * good + 100 * ok + 50 * meh) / (300 * total);
  const silver = modAcronyms.includes("HD");
  const rank = accuracy >= 1 ? (silver ? "XH" : "X") : accuracy > 0.95 ? (silver ? "SH" : "S") : accuracy > 0.9 ? "A" : "B";
  const mapIndex = DEV_SIM_MAPS.indexOf(map);
  const coverUrl = makeDevCoverUrl(mapIndex);
  return {
    id: devSimNextScoreId--,
    legacy_score_id: null,
    user_id: user.id,
    accuracy,
    mods: modAcronyms.map((acronym) => ({ acronym })),
    score: Math.round(1_000_000 * accuracy ** 4),
    total_score: Math.round(1_000_000 * accuracy ** 4),
    max_combo: miss === 0 ? total : Math.round(total * (0.25 + Math.random() * 0.6)),
    passed: true,
    rank,
    statistics: { perfect, great, good, ok, meh, miss },
    pp: Math.round(map.stars ** 2.2 * 8 * accuracy ** 6),
    beatmap: {
      id: map.beatmapId,
      beatmapset_id: map.beatmapsetId,
      difficulty_rating: map.stars,
      mode: "mania",
      cs: map.keys,
      bpm: map.bpm,
      max_combo: total,
      version: map.version,
      // Empty on purpose: getBeatmapUrl treats "" as no link, so simulated
      // rows never point at nonexistent osu! pages.
      url: "",
    },
    beatmapset: {
      id: map.beatmapsetId,
      title: map.title,
      artist: map.artist,
      covers: {
        cover: coverUrl,
        "cover@2x": coverUrl,
        card: coverUrl,
        "card@2x": coverUrl,
        list: coverUrl,
        "list@2x": coverUrl,
        slimcover: coverUrl,
        "slimcover@2x": coverUrl,
      },
    },
    user,
    ended_at: new Date(endedAtMs).toISOString(),
    has_replay: false,
  };
}

function parseTrackerSort(value: unknown): TrackerSort {
  return value === "stars" ? "stars" : "recent";
}

function parseTrackerSortDirection(value: unknown): TrackerSortDirection {
  return value === "asc" ? "asc" : "desc";
}

export const Route = createFileRoute("/tracker")({
  validateSearch: (search: Record<string, unknown>) => {
    const sort = parseTrackerSort(search.sort);
    const sortDirection = parseTrackerSortDirection(search.sortDirection ?? search.dir);
    return {
      country: parseCountrySearchParam(search.country),
      page: (() => {
        const n = Number(search.page);
        if (!Number.isFinite(n) || n < 0) return undefined;
        return Math.floor(n);
      })(),
      ...(sort === "stars"
        ? {
            sort,
            ...(sortDirection === "asc" ? { sortDirection } : {}),
          }
        : {}),
    };
  },
  search: {
    middlewares: [stripSearchParams({ page: undefined, sort: undefined, sortDirection: undefined })],
  },
  head: ({ match }) => {
    const country = match.search.country;
    const countryName = country ? getCountryName(country) : null;
    return {
      meta: [
        { title: countryName ? `Live score tracker - ${countryName}` : "Live score tracker" },
        { name: "description", content: "" },
        { name: "robots", content: "noindex, nofollow" },
      ],
    };
  },
  component: ScoresPage,
});

type ScoreFilter = "all" | "ranked";
type GradeFilter = "all" | "SS" | "S" | "A" | "B";
type KeyFilter = "all" | "4k" | "other";
type MissFilter = "all" | "fc" | "fc_choke";
type TrackerSort = "recent" | "stars";
type TrackerSortDirection = "asc" | "desc";
type TrackerBackendFilterOptions = {
  scoreFilter?: "ranked";
  grade?: Exclude<GradeFilter, "all">;
  key?: Exclude<KeyFilter, "all">;
  miss?: Exclude<MissFilter, "all">;
};

function scoreMatchesKeyFilter(score: LeanTrackerScore, keyFilter: KeyFilter): boolean {
  if (keyFilter === "all") return true;
  const keys = getBeatmapKeyCount(score.beatmap);
  if (keys == null) return false;
  return keyFilter === "4k" ? keys === 4 : keys !== 4;
}

function getScoreMissCount(score: LeanTrackerScore): number {
  const stats = score.statistics ?? {};
  return stats.count_miss ?? stats.miss ?? 0;
}

function scoreMatchesMissFilter(score: LeanTrackerScore, missFilter: MissFilter): boolean {
  if (missFilter === "all") return true;
  const misses = getScoreMissCount(score);
  return missFilter === "fc" ? misses === 0 : misses === 1;
}

function scoreMatchesTrackerFilters(
  score: LeanTrackerScore,
  filters: { filter: ScoreFilter; gradeFilter: GradeFilter; keyFilter: KeyFilter; missFilter: MissFilter },
): boolean {
  if (!isDisplayedPassed(score)) return false;
  if (!scoreMatchesKeyFilter(score, filters.keyFilter)) return false;
  if (!scoreMatchesMissFilter(score, filters.missFilter)) return false;
  if (filters.filter === "ranked") return score.pp != null && score.pp > 0;
  if (filters.gradeFilter !== "all") {
    const rank = getDisplayedRank(score);
    if (filters.gradeFilter === "SS") return ["SS", "SSH", "X", "XH"].includes(rank);
    if (filters.gradeFilter === "S") return ["S", "SH"].includes(rank);
    return rank === filters.gradeFilter;
  }
  return true;
}

function getBackendTrackerFilters(filters: { filter: ScoreFilter; gradeFilter: GradeFilter; keyFilter: KeyFilter; missFilter: MissFilter }): TrackerBackendFilterOptions {
  return {
    scoreFilter: filters.filter === "ranked" ? "ranked" : undefined,
    grade: filters.gradeFilter === "all" ? undefined : filters.gradeFilter,
    key: filters.keyFilter === "all" ? undefined : filters.keyFilter,
    miss: filters.missFilter === "all" ? undefined : filters.missFilter,
  };
}

function getStarRating(score: LeanTrackerScore): number {
  return score.beatmap?.difficulty_rating ?? -1;
}

function compareTrackerScores(a: LeanTrackerScore, b: LeanTrackerScore, sort: TrackerSort, direction: TrackerSortDirection): number {
  if (sort === "stars") {
    const starDelta = direction === "asc"
      ? (a.beatmap?.difficulty_rating ?? Number.MAX_SAFE_INTEGER) - (b.beatmap?.difficulty_rating ?? Number.MAX_SAFE_INTEGER)
      : getStarRating(b) - getStarRating(a);
    if (starDelta !== 0) return starDelta;
  }
  return getScoreTimeMs(b) - getScoreTimeMs(a);
}

function sortTrackerScores(scores: LeanTrackerScore[], sort: TrackerSort, direction: TrackerSortDirection): LeanTrackerScore[] {
  if (sort === "recent") return scores;
  return [...scores].sort((a, b) => compareTrackerScores(a, b, sort, direction));
}

function getLiveTrackerSnapshotOptions(country: string, options: { offset?: number; filters?: TrackerBackendFilterOptions; sort?: TrackerSort; sortDirection?: TrackerSortDirection; userIds?: number[] } = {}): { offset?: number; hours?: number; filters?: TrackerBackendFilterOptions; sort?: TrackerSort; sortDirection?: TrackerSortDirection; userIds?: number[] } {
  return isGlobalScope(country) ? { ...options, hours: TRACKER_GLOBAL_WINDOW_HOURS } : options;
}

function getLiveTrackerTotal(country: string, total: number | null | undefined): number {
  const normalizedTotal = Math.max(0, Math.floor(total ?? 0));
  return isGlobalScope(country) ? normalizedTotal : Math.min(TRACKER_FEED_SCORE_LIMIT, normalizedTotal);
}

/**
 * How many scores the feed believes exist for the current scope. The backend's
 * total normally acts as a floor so pagination is sized before every page has
 * been fetched -- but that total counts stored passes while the feed only
 * renders displayable ones (getScoreDisplayValues hides D ranks). Once a
 * snapshot comes back short of its limit we hold everything the backend has, so
 * the floor has to drop: keeping it would leave the page permanently short of a
 * target it can never reach, spinning skeletons forever on any country whose
 * whole history fits in one page (CW, AD).
 */
export function getTrackerWindowCount(options: {
  displayableCount: number;
  selectedCountry: string;
  liveTrackerTotal: number | null;
  liveFilteredTotal: number | null;
  liveBackendEnabled: boolean;
  hasActiveScoreFilters: boolean;
  useLiveBackendFilteredScores: boolean;
  drained: boolean;
}): number {
  const { displayableCount, selectedCountry, liveTrackerTotal, drained } = options;
  if (options.useLiveBackendFilteredScores) return options.liveFilteredTotal ?? 0;
  if (!options.liveBackendEnabled || options.hasActiveScoreFilters) return displayableCount;
  if (drained) return displayableCount;
  const availableCount = liveTrackerTotal == null
    ? (isGlobalScope(selectedCountry) ? displayableCount : TRACKER_FEED_SCORE_LIMIT)
    : getLiveTrackerTotal(selectedCountry, liveTrackerTotal);
  return Math.max(displayableCount, availableCount);
}

// How many scores must be in hand before the current page can stop showing
// skeletons. Zero when the feed isn't backend-paginated.
export function getRequiredScoreCountForPage(options: {
  currentPage: number;
  trackerWindowCount: number;
  liveBackendEnabled: boolean;
  hasActiveScoreFilters: boolean;
}): number {
  if (!options.liveBackendEnabled || options.hasActiveScoreFilters) return 0;
  return Math.min((options.currentPage + 1) * TRACKER_PAGE_SIZE, options.trackerWindowCount);
}

const EMPTY_SCORES: LeanTrackerScore[] = [];
const EMPTY_KEY_SET: ReadonlySet<string> = new Set<string>();

// One virtualized feed row: either a plain score or a whole multiplayer-lobby
// session (every map it played) rendered as a single expandable card.
type TrackerFeedEntry =
  | { kind: "score"; key: string; score: LeanTrackerScore }
  | { kind: "multi"; key: string; rounds: TrackerMultiRound[] };
const EMPTY_SCORE_GAINS: Record<number, { fetchedAt: number; value: number }> = {};


function ScoresPage() {
  const navigate = useNavigate();
  const { country, page: searchPage, sort: searchSort, sortDirection: searchSortDirection } = Route.useSearch();
  const trackerSort: TrackerSort = searchSort ?? "recent";
  const trackerSortDirection: TrackerSortDirection = trackerSort === "stars" ? (searchSortDirection ?? "desc") : "desc";
  const page = searchPage ?? 0;
  const fallbackCountry = useSelectedCountry();
  const selectedCountry = country ?? fallbackCountry;
  const selectedCountryRef = useRef(selectedCountry);
  selectedCountryRef.current = selectedCountry;
  const selectedIsGlobal = isGlobalScope(selectedCountry);
  // Multi-country scopes (Global, regions) show each row's country flag.
  const selectedIsMultiCountry = selectedIsGlobal || isRegionScope(selectedCountry);
  const feedScores = useAppStore((state) => state.feedScoresByCountry[selectedCountry]) ?? EMPTY_SCORES;
  const feedScoresFetchedAt = useAppStore((state) => state.feedScoresFetchedAtByCountry[selectedCountry]) ?? null;
  const addFeedScores = useAppStore((state) => state.addFeedScores);
  const markFeedScoresFetched = useAppStore((state) => state.markFeedScoresFetched);
  const hiddenUserIds = useHiddenUserIds();
  const [filter, setFilter] = useState<ScoreFilter>("all");
  const [gradeFilter, setGradeFilter] = useState<GradeFilter>("all");
  const [keyFilter, setKeyFilter] = useState<KeyFilter>("all");
  const [missFilter, setMissFilter] = useState<MissFilter>("all");
  const [selectedPlayerIds, setSelectedPlayerIds] = useState<number[]>([]);
  const [initialLoaded, setInitialLoaded] = useState(feedScores.length > 0 || !!feedScoresFetchedAt);
  const initialLoadedCountryRef = useRef(selectedCountry);
  const initialLoadedForSelectedCountry = initialLoadedCountryRef.current === selectedCountry
    ? initialLoaded
    : feedScores.length > 0 || !!feedScoresFetchedAt;
  const [simulateHighTraffic, setSimulateHighTraffic] = useState(false);
  const [simulateFeedActivity, setSimulateFeedActivity] = useState(false);
  const [simFeedScores, setSimFeedScores] = useState<LeanTrackerScore[]>([]);
  const [timeTick, setTimeTick] = useState(0);
  const [liveSnapshotLoading, setLiveSnapshotLoading] = useState(false);
  const [liveTrackerTotal, setLiveTrackerTotal] = useState<number | null>(null);
  // Country whose whole feed already fits in one snapshot, so the backend has
  // nothing left to hand over. Country-keyed rather than a bare flag so a
  // switch can't carry the previous country's exhaustion into the new one.
  const [exhaustedTrackerCountry, setExhaustedTrackerCountry] = useState<string | null>(null);
  const [liveFeedState, setLiveFeedState] = useState<"live" | "delayed" | "reconnecting">("live");
  const [livePageScores, setLivePageScores] = useState<LeanTrackerScore[]>([]);
  const [livePageSnapshotKey, setLivePageSnapshotKey] = useState<string | null>(null);
  const [livePageLoading, setLivePageLoading] = useState(false);
  const [liveFilteredTotal, setLiveFilteredTotal] = useState<number | null>(null);
  const [liveFilteredScores, setLiveFilteredScores] = useState<LeanTrackerScore[]>([]);
  const [liveFilteredSnapshotKey, setLiveFilteredSnapshotKey] = useState<string | null>(null);
  const [liveFilteredLoading, setLiveFilteredLoading] = useState(false);
  const refreshing = liveSnapshotLoading || livePageLoading || liveFilteredLoading;
  const liveSnapshotInFlightRef = useRef(false);
  const liveSnapshotInFlightLimitRef = useRef(0);
  const queuedLiveSnapshotLimitRef = useRef<number | null>(null);
  const livePageRequestIdRef = useRef(0);
  const liveFilteredRequestIdRef = useRef(0);
  const lastLiveSnapshotAtRef = useRef(0);
  const knownLiveScoreIdentitiesRef = useRef<Set<string>>(new Set());
  const liveBackendEnabled = isLiveBackendConfigured();
  const windowActive = useWindowActive();
  const { warming } = useCountryWarming(selectedCountry);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const handleToggleExpand = useCallback((key: string) => {
    setExpandedKey((prev) => (prev === key ? null : key));
  }, []);
  // Multi-lobby cards expand independently of the single-score detail
  // accordion, so a lobby can stay open while browsing member details inside.
  const [expandedMultiKeys, setExpandedMultiKeys] = useState<ReadonlySet<string>>(EMPTY_KEY_SET);
  const handleToggleMulti = useCallback((key: string) => {
    setExpandedMultiKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);
  const trackerPpGainEntries = useAppStore((state) => state.trackerPpGainsByCountry[selectedCountry] ?? EMPTY_SCORE_GAINS);
  const setTrackerPpGains = useAppStore((state) => state.setTrackerPpGains);
  const countryName = getCountryName(selectedCountry);
  const hasActiveScoreFilters = selectedPlayerIds.length > 0
    || filter !== "all"
    || gradeFilter !== "all"
    || keyFilter !== "all"
    || missFilter !== "all"
    || hiddenUserIds.size > 0;
  const hasBackendScoreFilters = filter !== "all"
    || gradeFilter !== "all"
    || keyFilter !== "all"
    || missFilter !== "all";
  const useLiveBackendFilteredScores = liveBackendEnabled
    && (
      (selectedIsGlobal && (hasBackendScoreFilters || selectedPlayerIds.length > 0))
      || (trackerSort !== "recent" && selectedPlayerIds.length === 0)
    )
    && hiddenUserIds.size === 0;

  useEffect(() => {
    if (!windowActive) return;
    const id = window.setInterval(() => setTimeTick((value) => value + 1), 30_000);
    return () => window.clearInterval(id);
  }, [windowActive]);

  useEffect(() => {
    for (const score of feedScores) {
      knownLiveScoreIdentitiesRef.current.add(getScoreIdentity(score));
    }
  }, [feedScores]);

  const reconcileLiveSnapshot = useCallback(async (
    requestedCountry: string,
    options: { force?: boolean; limit?: number } = {},
  ) => {
    const now = Date.now();
    const requestedLimit = options.limit ?? TRACKER_LIVE_RECONCILE_LIMIT;
    if (!options.force && now - lastLiveSnapshotAtRef.current < TRACKER_LIVE_RECONCILE_MIN_INTERVAL_MS) return;
    if (liveSnapshotInFlightRef.current) {
      if (options.force || requestedLimit > liveSnapshotInFlightLimitRef.current) {
        queuedLiveSnapshotLimitRef.current = Math.max(queuedLiveSnapshotLimitRef.current ?? 0, requestedLimit);
      }
      return;
    }

    liveSnapshotInFlightRef.current = true;
    liveSnapshotInFlightLimitRef.current = requestedLimit;
    setLiveSnapshotLoading(true);
    try {
      const liveSnapshot = await fetchLiveTrackerSnapshot(requestedCountry, requestedLimit, getLiveTrackerSnapshotOptions(requestedCountry));
      if (requestedCountry !== selectedCountryRef.current) return;
      lastLiveSnapshotAtRef.current = Date.now();
      if (Number.isFinite(liveSnapshot.total)) {
        setLiveTrackerTotal(getLiveTrackerTotal(requestedCountry, liveSnapshot.total));
      }
      // A short snapshot means we hold every score the backend has. That
      // matters because its total counts stored passes while the feed only
      // shows displayable ones (getScoreDisplayValues hides D ranks), so on a
      // country whose entire history is shorter than one page the gap is
      // permanent: the page would wait forever on rows that never come.
      setExhaustedTrackerCountry(liveSnapshot.scores.length < requestedLimit ? requestedCountry : null);
      const passedScores = liveSnapshot.scores.filter(isDisplayedPassed);
      if (passedScores.length > 0) addFeedScores(requestedCountry, passedScores);
      if (Object.keys(liveSnapshot.gains).length > 0) {
        setTrackerPpGains(requestedCountry, liveSnapshot.gains, liveSnapshot.fetchedAt);
      }
      markFeedScoresFetched(requestedCountry);
      initialLoadedCountryRef.current = requestedCountry;
      setInitialLoaded(true);
    } finally {
      liveSnapshotInFlightRef.current = false;
      liveSnapshotInFlightLimitRef.current = 0;
      const queuedLimit = queuedLiveSnapshotLimitRef.current;
      queuedLiveSnapshotLimitRef.current = null;
      if (queuedLimit != null && requestedCountry === selectedCountryRef.current) {
        void reconcileLiveSnapshot(requestedCountry, { force: true, limit: queuedLimit });
      } else {
        setLiveSnapshotLoading(false);
      }
    }
  }, [addFeedScores, markFeedScoresFetched, setTrackerPpGains]);

  useEffect(() => {
    if (!liveBackendEnabled || !windowActive) return;
    const requestedCountry = selectedCountry;
    reconcileLiveSnapshot(requestedCountry, { force: true, limit: TRACKER_LIVE_MIN_SNAPSHOT_LIMIT }).catch(() => {
      // Transient backend failure: the SSE feed and the next reconcile retry cover it.
    });
  }, [liveBackendEnabled, reconcileLiveSnapshot, selectedCountry, windowActive]);

  // Unlike the other live surfaces, the tracker feed stays connected while the
  // window is unfocused so new scores keep popping in on a second monitor while
  // you play. The per-frame work (animations, home canvas, 3D card) is what
  // pauses on blur; this SSE feed only does work when a score actually arrives,
  // so it is intentionally not gated on windowActive.
  useEffect(() => {
    if (!liveBackendEnabled) return;
    const source = openLiveEventSource(selectedCountry);
    if (!source) return;
    setLiveFeedState("live");
    source.onopen = () => setLiveFeedState("live");
    source.onerror = () => setLiveFeedState("reconnecting");
    // Connected is not the same as live: heartbeats report when the backend
    // pipeline last ingested a score, so a wedged backend shows as delayed
    // instead of a green light over a frozen feed.
    source.addEventListener("heartbeat", (event) => {
      try {
        const data = JSON.parse(event.data) as { t?: number; ingest_at?: number | null };
        if (typeof data.t !== "number" || typeof data.ingest_at !== "number") {
          setLiveFeedState("live");
          return;
        }
        setLiveFeedState(data.t - data.ingest_at > TRACKER_INGEST_DELAYED_AFTER_MS ? "delayed" : "live");
      } catch {
        // Malformed heartbeat: leave the indicator as-is.
      }
    });
    source.addEventListener("tracker_score", (event) => {
      setLiveFeedState((current) => current === "live" ? current : "live");
      const score = JSON.parse(event.data) as LeanTrackerScore;
      if (!isDisplayedPassed(score)) return;
      const identity = getScoreIdentity(score);
      const alreadyKnown = knownLiveScoreIdentitiesRef.current.has(identity);
      knownLiveScoreIdentitiesRef.current.add(identity);
      addFeedScores(selectedCountry, [score]);
      if (!alreadyKnown) {
        setLiveTrackerTotal((current) => {
          if (current == null) return current;
          return getLiveTrackerTotal(selectedCountry, current + 1);
        });
        const scoreMatchesSelectedPlayerFilter = selectedPlayerIds.length === 0 || selectedPlayerIds.includes(score.user_id);
        if (useLiveBackendFilteredScores && scoreMatchesSelectedPlayerFilter && scoreMatchesTrackerFilters(score, { filter, gradeFilter, keyFilter, missFilter })) {
          setLiveFilteredTotal((current) => current == null ? current : current + 1);
          setLiveFilteredScores((current) => page === 0 ? sortTrackerScores([score, ...current], trackerSort, trackerSortDirection).slice(0, TRACKER_PAGE_SIZE) : current);
        }
      }
    });
    source.addEventListener("score_gain", (event) => {
      const data = JSON.parse(event.data) as { scoreId?: number; ppGain?: number };
      if (data.scoreId != null && data.ppGain != null) {
        setTrackerPpGains(selectedCountry, { [data.scoreId]: data.ppGain });
      }
    });
    return () => source.close();
  }, [addFeedScores, filter, gradeFilter, keyFilter, liveBackendEnabled, missFilter, page, reconcileLiveSnapshot, selectedCountry, selectedPlayerIds, setTrackerPpGains, trackerSort, trackerSortDirection, useLiveBackendFilteredScores]);

  useEffect(() => {
    initialLoadedCountryRef.current = selectedCountry;
    setInitialLoaded(feedScores.length > 0 || !!feedScoresFetchedAt);
    liveSnapshotInFlightRef.current = false;
    liveSnapshotInFlightLimitRef.current = 0;
    queuedLiveSnapshotLimitRef.current = null;
    lastLiveSnapshotAtRef.current = 0;
    setLiveSnapshotLoading(false);
    setLiveTrackerTotal(null);
    setExhaustedTrackerCountry(null);
    setLivePageScores([]);
    setLivePageSnapshotKey(null);
    setLivePageLoading(false);
    livePageRequestIdRef.current += 1;
    setLiveFilteredTotal(null);
    setLiveFilteredScores([]);
    setLiveFilteredSnapshotKey(null);
    setLiveFilteredLoading(false);
    liveFilteredRequestIdRef.current += 1;
    knownLiveScoreIdentitiesRef.current = new Set();
    setExpandedKey(null);
    setExpandedMultiKeys(EMPTY_KEY_SET);
    setSelectedPlayerIds([]);
  }, [selectedCountry]);

  useEffect(() => {
    if (feedScores.length > 0 || !!feedScoresFetchedAt) {
      initialLoadedCountryRef.current = selectedCountry;
      setInitialLoaded(true);
    }
  }, [feedScores.length, feedScoresFetchedAt, selectedCountry]);

  useEffect(() => {
    setExpandedKey(null);
    setExpandedMultiKeys(EMPTY_KEY_SET);
  }, [filter, gradeFilter, keyFilter, missFilter, trackerSort, trackerSortDirection]);

  const ppGainByScoreId = useMemo(
    () => Object.fromEntries(
      Object.entries(trackerPpGainEntries)
        .filter(([, entry]) => Date.now() - entry.fetchedAt < TRACKER_PP_GAIN_CLIENT_TTL)
        .map(([scoreId, entry]) => [Number(scoreId), entry.value]),
    ) as Record<number, number>,
    [trackerPpGainEntries],
  );

  const selectedPlayerIdSet = useMemo(() => new Set(selectedPlayerIds), [selectedPlayerIds]);
  const selectedPlayersKey = selectedPlayerIds.join(",");

  // Dev feed simulation: while toggled on, emit one synthetic score per tick.
  // A simulated lobby keeps the same members across 2-4 maps; each round
  // queues every member on one map (same rate mods) so they trickle in a tick
  // apart, inside the co-finish window - and the repeated rounds satisfy the
  // detector's happened-at-least-twice rule like a real lobby session does.
  // Scores live only in this local state, never in the persisted store.
  useEffect(() => {
    if (!import.meta.env.DEV || !simulateFeedActivity) {
      setSimFeedScores([]);
      return;
    }
    const users = makeDevSimUsers(DEV_FEED_SIM_USER_COUNT);
    const pickMap = () => DEV_SIM_MAPS[Math.floor(Math.random() * DEV_SIM_MAPS.length)];
    const pickRateMods = () => (Math.random() < 0.25 ? (Math.random() < 0.5 ? ["DT"] : ["HT"]) : []);
    const withHdMaybe = (mods: string[]) => (Math.random() < 0.3 ? [...mods, "HD"] : mods);

    // Seed a finished two-map lobby plus a couple of solo plays so a MULTI
    // card is visible immediately instead of two lobby-rounds later.
    const now = Date.now();
    const seedLobby = users.slice(0, 3);
    const seedMap1 = DEV_SIM_MAPS[0];
    const seedMap2 = DEV_SIM_MAPS[1];
    const seed = [
      ...seedLobby.map((user, index) => makeDevSimScore(user, seedMap1, [], now - 100_000 + index * 3_000)),
      ...seedLobby.map((user, index) => makeDevSimScore(user, seedMap2, [], now - 40_000 + index * 4_000)),
      makeDevSimScore(users[4], DEV_SIM_MAPS[2], ["DT"], now - 24_000),
      makeDevSimScore(users[5], DEV_SIM_MAPS[3], [], now - 11_000),
    ];
    setSimFeedScores(seed);

    let pending: Array<{ user: DevSimUser; map: DevSimMap; mods: string[] }> = [];
    let activeLobby: { members: DevSimUser[]; roundsLeft: number; lastMapId: number | null } | null = null;
    const queueLobbyRound = () => {
      if (!activeLobby) return;
      let map = pickMap();
      // Back-to-back rounds on the same map would chain into one detection
      // cluster; a real lobby moves on to the next pick, so the sim does too.
      while (map.beatmapId === activeLobby.lastMapId) map = pickMap();
      activeLobby.lastMapId = map.beatmapId;
      const rateMods = pickRateMods();
      pending = activeLobby.members.map((user) => ({ user, map, mods: withHdMaybe(rateMods) }));
      activeLobby.roundsLeft -= 1;
      if (activeLobby.roundsLeft <= 0) activeLobby = null;
    };
    const scheduleEvent = () => {
      if (activeLobby) {
        queueLobbyRound();
        return;
      }
      if (Math.random() < DEV_FEED_SIM_LOBBY_CHANCE) {
        const size = 2 + Math.floor(Math.random() * 3);
        activeLobby = {
          members: [...users].sort(() => Math.random() - 0.5).slice(0, size),
          roundsLeft: 2 + Math.floor(Math.random() * 3),
          lastMapId: null,
        };
        queueLobbyRound();
      } else {
        pending = [{ user: users[Math.floor(Math.random() * users.length)], map: pickMap(), mods: withHdMaybe(pickRateMods()) }];
      }
    };
    const intervalId = window.setInterval(() => {
      if (pending.length === 0) scheduleEvent();
      const next = pending.shift();
      if (!next) return;
      const score = makeDevSimScore(next.user, next.map, next.mods, Date.now());
      setSimFeedScores((current) => [score, ...current].slice(0, DEV_FEED_SIM_MAX_SCORES));
    }, DEV_FEED_SIM_INTERVAL_MS);
    return () => window.clearInterval(intervalId);
  }, [simulateFeedActivity]);

  const feedScoresWithSim = useMemo(
    () => (simFeedScores.length > 0 ? [...simFeedScores, ...feedScores] : feedScores),
    [feedScores, simFeedScores],
  );

  // Suspected multiplayer-lobby rounds, detected over every score pool we hold
  // (the live feed plus deep-page/filtered snapshots) so lobbies don't split at
  // page boundaries. Maps score identity -> shared group.
  const multiGroupByScoreKey = useMemo(
    () => detectTrackerMultis([...feedScoresWithSim, ...livePageScores, ...liveFilteredScores]),
    [feedScoresWithSim, liveFilteredScores, livePageScores],
  );

  const updateTrackerSearch = useCallback((patch: Partial<{ country: string | undefined; page: number | undefined; sort: TrackerSort; sortDirection: TrackerSortDirection }>) => {
    const nextPage = patch.page ?? page;
    const nextCountry = patch.country ?? country;
    const nextSort = patch.sort ?? trackerSort;
    const nextSortDirection = nextSort === "stars"
      ? (patch.sortDirection ?? trackerSortDirection)
      : "desc";
    const currentSortDirection = trackerSort === "stars" ? trackerSortDirection : "desc";
    const nextPageParam = nextPage > 0 ? nextPage : undefined;
    const currentPageParam = page > 0 ? page : undefined;
    if (
      nextCountry === country
      && nextPageParam === currentPageParam
      && nextSort === trackerSort
      && nextSortDirection === currentSortDirection
    ) return;

    navigate({
      to: "/tracker",
      search: {
        country: nextCountry,
        page: nextPageParam,
        sort: nextSort === "stars" ? nextSort : undefined,
        sortDirection: nextSort === "stars" && nextSortDirection === "asc" ? nextSortDirection : undefined,
      },
      replace: true,
      resetScroll: false,
    });
  }, [country, navigate, page, trackerSort, trackerSortDirection]);

  const togglePlayerFilter = useCallback((playerId: number) => {
    setSelectedPlayerIds((current) =>
      current.includes(playerId)
        ? current.filter((id) => id !== playerId)
        : [...current, playerId]
    );
    updateTrackerSearch({ page: 0 });
  }, [updateTrackerSearch]);

  const clearPlayerFilter = useCallback(() => {
    setSelectedPlayerIds([]);
    updateTrackerSearch({ page: 0 });
  }, [updateTrackerSearch]);

  const filtered = useMemo(() => {
    const playerFiltered = selectedPlayerIds.length > 0
      ? feedScoresWithSim.filter((score: LeanTrackerScore) => selectedPlayerIdSet.has(score.user_id))
      : feedScoresWithSim;

    const nextFiltered = playerFiltered.filter((score: LeanTrackerScore) => {
      if (hiddenUserIds.has(score.user_id)) return false;
      return scoreMatchesTrackerFilters(score, { filter, gradeFilter, keyFilter, missFilter });
    });
    return sortTrackerScores(nextFiltered, trackerSort, trackerSortDirection);
  }, [feedScoresWithSim, filter, gradeFilter, keyFilter, missFilter, selectedPlayerIdSet, selectedPlayerIds.length, hiddenUserIds, trackerSort, trackerSortDirection]);

  const activePlayers = useMemo(() => {
    const activeCutoff = Date.now() - 40 * 60 * 1000;
    const seen = new Map<number, ActivePlayerRailInfo>();
    for (const score of feedScoresWithSim) {
      const timeMs = getScoreTimeMs(score);
      if (timeMs < activeCutoff || !score.user) continue;
      if (hiddenUserIds.has(score.user_id)) continue;
      const existing = seen.get(score.user_id);
      if (!existing || timeMs > existing.latestTime) {
        seen.set(score.user_id, {
          username: score.user.username,
          avatar_url: score.user.avatar_url,
          latestTime: timeMs,
        });
      }
    }
    const realPlayers = [...seen.entries()]
      .sort((a, b) => b[1].latestTime - a[1].latestTime)
      .map(([id, info]) => ({ id, ...info }));
    if (!import.meta.env.DEV || !simulateHighTraffic || realPlayers.length >= DEV_ACTIVE_PLAYER_SIMULATION_COUNT) {
      return realPlayers;
    }
    return [
      ...realPlayers,
      ...makeDevActivePlayers(DEV_ACTIVE_PLAYER_SIMULATION_COUNT - realPlayers.length),
    ];
  }, [feedScoresWithSim, hiddenUserIds, simulateHighTraffic]);

  // Desktop active-player rail scrolls internally; fade the edge(s) that have
  // hidden avatars so the list never cuts off abruptly (and hide the scrollbar).
  const activeRailRef = useRef<HTMLDivElement | null>(null);
  const [railFade, setRailFade] = useState<{ top: boolean; bottom: boolean }>({ top: false, bottom: false });
  const updateRailFade = useCallback(() => {
    const el = activeRailRef.current;
    if (!el) return;
    const top = el.scrollTop > 4;
    const bottom = el.scrollTop + el.clientHeight < el.scrollHeight - 4;
    setRailFade((prev) => (prev.top === top && prev.bottom === bottom ? prev : { top, bottom }));
  }, []);
  useEffect(() => {
    updateRailFade();
    window.addEventListener("resize", updateRailFade);
    return () => window.removeEventListener("resize", updateRailFade);
  }, [activePlayers.length, updateRailFade]);
  const railMaskClass = railFade.top && railFade.bottom
    ? "tracker-rail--tb"
    : railFade.top
      ? "tracker-rail--t"
      : railFade.bottom
        ? "tracker-rail--b"
        : "";

  const filters: { id: ScoreFilter; label: string }[] = [
    { id: "all", label: "All" },
    { id: "ranked", label: "Ranked (PP)" },
  ];
  const grades: { id: GradeFilter; label: string }[] = [
    { id: "all", label: "Any" },
    { id: "SS", label: "SS" },
    { id: "S", label: "S" },
    { id: "A", label: "A" },
    { id: "B", label: "B" },
  ];
  const keymodes: { id: KeyFilter; label: string }[] = [
    { id: "all", label: "Any" },
    { id: "4k", label: "4K" },
    { id: "other", label: "≠4K" },
  ];
  const cycleStarSort = (direction: 1 | -1 = 1) => {
    const states: Array<{ sort: TrackerSort; direction: TrackerSortDirection }> = [
      { sort: "recent", direction: "desc" },
      { sort: "stars", direction: "desc" },
      { sort: "stars", direction: "asc" },
    ];
    const currentIndex = states.findIndex((state) => state.sort === trackerSort && state.direction === trackerSortDirection);
    const next = states[(currentIndex + direction + states.length) % states.length] ?? states[0];
    updateTrackerSearch({ page: 0, sort: next.sort, sortDirection: next.direction });
  };
  const cycleMissFilter = (direction: 1 | -1 = 1) => {
    const states: MissFilter[] = ["all", "fc", "fc_choke"];
    setMissFilter((current) => {
      const currentIndex = states.indexOf(current);
      return states[(currentIndex + direction + states.length) % states.length] ?? "all";
    });
    updateTrackerSearch({ page: 0 });
  };
  // Desktop shows the three combo states as segments, so they can be picked
  // directly; the compact mobile control still cycles through them.
  const selectMissFilter = (next: MissFilter) => {
    setMissFilter(next);
    updateTrackerSearch({ page: 0 });
  };
  useEffect(() => {
    if (!liveBackendEnabled || !windowActive || !hasActiveScoreFilters || useLiveBackendFilteredScores || feedScores.length >= TRACKER_FEED_SCORE_LIMIT) return;
    void reconcileLiveSnapshot(selectedCountry, { force: true, limit: TRACKER_FEED_SCORE_LIMIT });
  }, [feedScores.length, hasActiveScoreFilters, liveBackendEnabled, reconcileLiveSnapshot, selectedCountry, useLiveBackendFilteredScores, windowActive]);
  const mobileMissButtonLabel = missFilter === "fc_choke" ? "Ch" : "FC";
  const missButtonTitle = missFilter === "fc"
    ? "Showing full combos (0 misses) - left click for FC chokes, right click to clear"
    : missFilter === "fc_choke"
      ? "Showing FC chokes (1 miss) - left click to clear, right click for FCs"
      : "Left click for FCs, right click for FC chokes";
  const starSortTitle = trackerSort === "stars"
    ? trackerSortDirection === "desc"
      ? "Sorting highest star rating first - left click for ascending, right click to clear"
      : "Sorting lowest star rating first - left click to clear, right click for descending"
    : "Left click for highest star rating first, right click for lowest first";
  const listKey = `${filter}:${gradeFilter}:${keyFilter}:${missFilter}:${trackerSort}:${trackerSortDirection}:${selectedPlayersKey}`;
  const trackerWindowCount = getTrackerWindowCount({
    displayableCount: filtered.length,
    selectedCountry,
    liveTrackerTotal,
    liveFilteredTotal,
    liveBackendEnabled,
    hasActiveScoreFilters,
    useLiveBackendFilteredScores,
    drained: exhaustedTrackerCountry === selectedCountry,
  });
  const totalPages = Math.max(1, Math.ceil(
    trackerWindowCount / TRACKER_PAGE_SIZE,
  ));
  const currentPage = Math.min(page, totalPages - 1);
  const requiredScoreCountForPage = getRequiredScoreCountForPage({
    currentPage,
    trackerWindowCount,
    liveBackendEnabled,
    hasActiveScoreFilters,
  });
  const livePageOffset = currentPage * TRACKER_PAGE_SIZE;
  const expectedLivePageSize = useLiveBackendFilteredScores && liveFilteredTotal == null
    ? TRACKER_PAGE_SIZE
    : Math.max(0, Math.min(TRACKER_PAGE_SIZE, trackerWindowCount - livePageOffset));
  const expectedLivePageEnd = livePageOffset + expectedLivePageSize;
  const needsLivePageSnapshot = liveBackendEnabled
    && !hasActiveScoreFilters
    && currentPage > 0
    && filtered.length < requiredScoreCountForPage;
  const currentLivePageSnapshotKey = `${selectedCountry}:${livePageOffset}:${expectedLivePageSize}`;
  const backendTrackerFilters = getBackendTrackerFilters({ filter, gradeFilter, keyFilter, missFilter });
  const currentLiveFilteredSnapshotKey = `${selectedCountry}:${livePageOffset}:${expectedLivePageSize}:${filter}:${gradeFilter}:${keyFilter}:${missFilter}:${trackerSort}:${trackerSortDirection}:${selectedPlayersKey}`;
  const hasLivePageSnapshot = needsLivePageSnapshot
    && livePageSnapshotKey === currentLivePageSnapshotKey;
  const hasLiveFilteredSnapshot = useLiveBackendFilteredScores
    && liveFilteredSnapshotKey === currentLiveFilteredSnapshotKey;
  const showingLivePageSkeletons = needsLivePageSnapshot
    ? !hasLivePageSnapshot
    : useLiveBackendFilteredScores
      ? !hasLiveFilteredSnapshot
      : liveBackendEnabled && !hasActiveScoreFilters && filtered.length < requiredScoreCountForPage;
  const paginatedScores = useMemo(
    () => hasLiveFilteredSnapshot
      ? liveFilteredScores.slice(0, expectedLivePageSize)
      : hasLivePageSnapshot
      ? livePageScores.slice(0, expectedLivePageSize)
      : filtered.slice(livePageOffset, expectedLivePageEnd),
    [expectedLivePageEnd, expectedLivePageSize, filtered, hasLiveFilteredSnapshot, hasLivePageSnapshot, liveFilteredScores, livePageOffset, livePageScores],
  );
  // Collapse a lobby's plays into one card entry, placed where the lobby's
  // first play sits in this page slice (the newest one under recent sort).
  // The card holds every round we know for the session, so plays below the
  // fold or on other pages still appear inside it.
  const feedEntries = useMemo(() => {
    const entries: TrackerFeedEntry[] = [];
    const emittedGroups = new Set<string>();
    for (const score of paginatedScores) {
      const identity = getScoreIdentity(score);
      const group = multiGroupByScoreKey.get(identity);
      if (!group) {
        entries.push({ kind: "score", key: identity, score });
        continue;
      }
      if (emittedGroups.has(group.key)) continue;
      emittedGroups.add(group.key);
      const visibleRounds = group.rounds
        .map((round) => ({ ...round, scores: round.scores.filter((member) => !hiddenUserIds.has(member.user_id)) }))
        .filter((round) => round.scores.length > 0);
      const visiblePlayers = new Set(visibleRounds.flatMap((round) => round.scores.map((member) => member.user_id)));
      if (visiblePlayers.size < 2) {
        // Hiding users can shrink a lobby to one player; show a plain row.
        entries.push({ kind: "score", key: identity, score });
      } else {
        entries.push({ kind: "multi", key: group.key, rounds: visibleRounds });
      }
    }
    return entries;
  }, [paginatedScores, multiGroupByScoreKey, hiddenUserIds]);
  const liveStatusLabel = liveFeedState === "delayed"
    ? "Live updates delayed"
    : liveFeedState === "reconnecting"
      ? "Live feed reconnecting"
      : "Live updates on";
  const liveStatusTitle = liveFeedState === "delayed"
    ? "Connected, but no new scores have come in for a few minutes. Recent plays will appear once the feed catches up."
    : liveFeedState === "reconnecting"
      ? "Connection lost; reconnecting."
      : "New scores stream in live over this connection.";
  const scoreWindowLabel = selectedIsGlobal
    ? liveTrackerTotal == null && !useLiveBackendFilteredScores
      ? "Last 24h"
      : `Last 24h \u00b7 ${formatNumber(trackerWindowCount)} scores`
    : `${formatNumber(trackerWindowCount)} scores`;

  useEffect(() => {
    if (!useLiveBackendFilteredScores) {
      setLiveFilteredTotal(null);
      setLiveFilteredScores([]);
      setLiveFilteredSnapshotKey(null);
      setLiveFilteredLoading(false);
      liveFilteredRequestIdRef.current += 1;
      return;
    }
    if (expectedLivePageSize === 0 && liveFilteredTotal != null) {
      setLiveFilteredScores([]);
      setLiveFilteredSnapshotKey(currentLiveFilteredSnapshotKey);
      setLiveFilteredLoading(false);
      return;
    }
    if (hasLiveFilteredSnapshot) {
      setLiveFilteredLoading(false);
      return;
    }

    const requestId = ++liveFilteredRequestIdRef.current;
    const requestedCountry = selectedCountry;
    const requestedKey = currentLiveFilteredSnapshotKey;
    setLiveFilteredLoading(true);
    fetchLiveTrackerSnapshot(
      requestedCountry,
      Math.max(1, expectedLivePageSize || TRACKER_PAGE_SIZE),
      getLiveTrackerSnapshotOptions(requestedCountry, {
        offset: livePageOffset,
        filters: backendTrackerFilters,
        sort: trackerSort,
        sortDirection: trackerSortDirection,
        userIds: selectedPlayerIds,
      }),
    )
      .then((snapshot) => {
        if (liveFilteredRequestIdRef.current !== requestId || requestedCountry !== selectedCountryRef.current) return;
        setLiveFilteredTotal(getLiveTrackerTotal(requestedCountry, snapshot.total ?? snapshot.scores.length));
        const passedScores = sortTrackerScores(snapshot.scores.filter(isDisplayedPassed), trackerSort, trackerSortDirection);
        setLiveFilteredScores(passedScores);
        setLiveFilteredSnapshotKey(requestedKey);
        if (Object.keys(snapshot.gains).length > 0) {
          setTrackerPpGains(requestedCountry, snapshot.gains, snapshot.fetchedAt);
        }
      })
      .catch(() => {
        if (liveFilteredRequestIdRef.current === requestId) {
          setLiveFilteredScores([]);
          setLiveFilteredSnapshotKey(requestedKey);
        }
      })
      .finally(() => {
        if (liveFilteredRequestIdRef.current === requestId) setLiveFilteredLoading(false);
      });
  }, [
    currentLiveFilteredSnapshotKey,
    expectedLivePageSize,
    filter,
    gradeFilter,
    hasLiveFilteredSnapshot,
    keyFilter,
    liveFilteredTotal,
    livePageOffset,
    missFilter,
    selectedPlayerIds,
    selectedPlayersKey,
    selectedCountry,
    setTrackerPpGains,
    trackerSort,
    trackerSortDirection,
    useLiveBackendFilteredScores,
  ]);

  useEffect(() => {
    if (!needsLivePageSnapshot) {
      setLivePageLoading(false);
      if (currentPage === 0 || hasActiveScoreFilters || !liveBackendEnabled) {
        setLivePageScores([]);
        setLivePageSnapshotKey(null);
      }
      return;
    }
    if (hasLivePageSnapshot || expectedLivePageSize === 0) {
      setLivePageLoading(false);
      return;
    }

    const requestId = ++livePageRequestIdRef.current;
    const requestedCountry = selectedCountry;
    const requestedKey = currentLivePageSnapshotKey;
    setLivePageLoading(true);
    fetchLiveTrackerSnapshot(requestedCountry, expectedLivePageSize, getLiveTrackerSnapshotOptions(requestedCountry, { offset: livePageOffset }))
      .then((snapshot) => {
        if (livePageRequestIdRef.current !== requestId || requestedCountry !== selectedCountryRef.current) return;
        if (Number.isFinite(snapshot.total)) {
          setLiveTrackerTotal(getLiveTrackerTotal(requestedCountry, snapshot.total));
        }
        const passedScores = snapshot.scores.filter(isDisplayedPassed);
        setLivePageScores(passedScores);
        setLivePageSnapshotKey(requestedKey);
        if (Object.keys(snapshot.gains).length > 0) {
          setTrackerPpGains(requestedCountry, snapshot.gains, snapshot.fetchedAt);
        }
      })
      .catch(() => {
        if (livePageRequestIdRef.current === requestId) {
          setLivePageScores([]);
          setLivePageSnapshotKey(requestedKey);
        }
      })
      .finally(() => {
        if (livePageRequestIdRef.current === requestId) setLivePageLoading(false);
      });
  }, [
    currentLivePageSnapshotKey,
    currentPage,
    expectedLivePageSize,
    hasActiveScoreFilters,
    hasLivePageSnapshot,
    liveBackendEnabled,
    livePageOffset,
    needsLivePageSnapshot,
    selectedCountry,
    setTrackerPpGains,
  ]);

  useEffect(() => {
    if (page !== currentPage) updateTrackerSearch({ page: currentPage });
  }, [currentPage, page, updateTrackerSearch]);

  const mobileHeaderKeymodeControls = (
    <div className="flex shrink-0 overflow-hidden rounded-lg border border-osu-b3/25 sm:hidden">
      {keymodes.map((item) => (
        <button
          key={item.id}
          onClick={() => { setKeyFilter(item.id); updateTrackerSearch({ page: 0 }); }}
          title={item.id === "other" ? "Show non-4K scores" : "Filter by keymode"}
          className={`px-2 py-1 text-[10px] font-semibold cursor-pointer transition-colors duration-[120ms] tabular-nums ${
            keyFilter === item.id
              ? "bg-osu-pink/15 text-osu-pink-light"
              : "bg-osu-b4/50 text-osu-f1 hover:text-osu-l2"
          }`}
        >
          {item.label}
        </button>
      ))}
    </div>
  );

  if (!liveBackendEnabled) {
    return (
      <div className="flex-1">
        <PageHeader iconSrc="/images/icons/news.svg" title={`${countryName} mania tracker`} />
        <LiveBackendRequired />
      </div>
    );
  }

  return (
    <div className="flex-1">
      <PageHeader
        iconSrc="/images/icons/news.svg"
        title={`${countryName} mania tracker`}
        right={
          <div className="flex flex-wrap items-center justify-end gap-2">
            {import.meta.env.DEV && (
              <button
                type="button"
                onClick={() => setSimulateHighTraffic((enabled) => !enabled)}
                className={`rounded-lg border px-2 py-1 text-[10px] font-semibold transition-colors ${
                  simulateHighTraffic
                    ? "border-osu-yellow/40 bg-osu-yellow/15 text-osu-yellow"
                    : "border-osu-pink/25 bg-osu-pink/10 text-osu-pink-light hover:bg-osu-pink/20"
                }`}
                title="Toggle simulated high-traffic active players"
              >
                {simulateHighTraffic ? "Sim 200 on" : "Sim 200"}
              </button>
            )}
            {import.meta.env.DEV && (
              <button
                type="button"
                onClick={() => setSimulateFeedActivity((enabled) => !enabled)}
                className={`rounded-lg border px-2 py-1 text-[10px] font-semibold transition-colors ${
                  simulateFeedActivity
                    ? "border-osu-yellow/40 bg-osu-yellow/15 text-osu-yellow"
                    : "border-osu-pink/25 bg-osu-pink/10 text-osu-pink-light hover:bg-osu-pink/20"
                }`}
                title="Toggle simulated tracker feed: solo scores plus multiplayer-lobby rounds that trigger the MULTI badge"
              >
                {simulateFeedActivity ? "Sim feed on" : "Sim feed"}
              </button>
            )}
            {refreshing || showingLivePageSkeletons ? (
              <>
                <div className="w-3 h-3 border-2 border-osu-pink/40 border-t-osu-pink rounded-full animate-spin" />
                <span className="text-[10px] text-osu-f1 tabular-nums">
                  Refreshing...
                </span>
              </>
            ) : (
              <>
                <div
                  className={`w-2 h-2 rounded-full ${
                    liveFeedState === "live"
                      ? "bg-osu-green animate-pulse"
                      : liveFeedState === "delayed"
                        ? "bg-osu-yellow"
                        : "bg-osu-red"
                  }`}
                />
                <span className="text-[10px] text-osu-f1" title={liveStatusTitle}>
                  {liveStatusLabel} {"\u00b7"} {scoreWindowLabel}
                </span>
              </>
            )}
            {mobileHeaderKeymodeControls}
          </div>
        }
      />

      {warming && <CountryWarming country={selectedCountry} />}

      {/* overflow-clip (not hidden) clips the triangle backdrop without creating
          a scroll container, so the sticky active-player rail inside resolves
          against the viewport. With overflow-hidden the rail stuck relative to
          this box and the "Playing" header snapped from too-high to its resting
          spot as the section height settled during the async load. */}
      {!warming && (
      <div className="relative overflow-clip bg-osu-b5">
      <OsuTriangleBackdrop />
      <div className="relative z-10 bg-osu-d5/90 border-b border-osu-b3/30 backdrop-blur-[1px]">
        <div className="max-w-[1200px] mx-auto px-4 sm:px-5 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-0">
          {/* Desktop: labelled filter groups on the left, sort pinned right. The
              groups are segmented controls rather than underlined tabs, which
              this site uses for navigation. */}
          <div className="hidden w-full items-center gap-x-5 gap-y-2 py-2.5 sm:flex">
            {selectedPlayerIds.length > 0 && (
              <button
                onClick={clearPlayerFilter}
                className="shrink-0 rounded-lg bg-osu-pink/15 px-2.5 py-1.5 text-[11px] font-semibold text-osu-pink-light transition-colors hover:bg-osu-pink/25 cursor-pointer"
              >
                Clear player filter
              </button>
            )}
            <FilterField label="Scores">
              <SegmentedControl
                id="tracker-source"
                value={filter}
                options={filters.map((item) => ({ value: item.id, label: item.label }))}
                onChange={(id) => { setFilter(id); if (id !== "all") setGradeFilter("all"); updateTrackerSearch({ page: 0 }); }}
              />
            </FilterField>
            <FilterField label="Grade">
              <SegmentedControl
                id="tracker-grade"
                size="icon"
                dimInactive
                value={gradeFilter}
                options={grades.map((item) => ({
                  value: item.id,
                  title: item.id === "all" ? "Any grade" : `${item.label} only`,
                  label: item.id === "all"
                    ? <span className="px-1 text-[11px]">Any</span>
                    : <GradeImg grade={item.id} size={20} />,
                }))}
                onChange={(id) => { setGradeFilter(id); if (id !== "all") setFilter("all"); updateTrackerSearch({ page: 0 }); }}
              />
            </FilterField>
            <FilterField label="Keys">
              <SegmentedControl
                id="tracker-keys"
                value={keyFilter}
                className="tabular-nums"
                options={keymodes.map((item) => ({
                  value: item.id,
                  label: item.label,
                  title: item.id === "other" ? "Show non-4K scores" : undefined,
                }))}
                onChange={(id) => { setKeyFilter(id); updateTrackerSearch({ page: 0 }); }}
              />
            </FilterField>
            <FilterField label="Combo">
              <SegmentedControl
                id="tracker-miss"
                value={missFilter}
                options={[
                  { value: "all", label: "Any" },
                  { value: "fc", label: "FC", title: "Full combos only (0 misses)" },
                  { value: "fc_choke", label: "Choke", title: "FC chokes only (1 miss)" },
                ]}
                onChange={selectMissFilter}
              />
            </FilterField>
            <div className="ml-auto">
              <FilterField label="Sort">
                <button
                  onClick={() => cycleStarSort(1)}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    cycleStarSort(-1);
                  }}
                  title={starSortTitle}
                  className={`cursor-pointer rounded-lg border px-2.5 py-1.5 text-[11px] font-semibold tabular-nums transition-colors duration-150 ${
                    trackerSort === "stars"
                      ? "border-osu-pink/30 bg-osu-pink/15 text-osu-pink-light"
                      : "border-osu-b3/25 bg-osu-b4/50 text-osu-f1 hover:text-osu-l2"
                  }`}
                >
                  Stars{trackerSort === "stars" ? (trackerSortDirection === "desc" ? " ↓" : " ↑") : ""}
                </button>
              </FilterField>
            </div>
          </div>
          {/* Mobile: compact single row */}
          <div className="sm:hidden w-full py-2">
            {selectedPlayerIds.length > 0 && (
              <button
                onClick={clearPlayerFilter}
                className="mb-2 px-2.5 py-1 rounded-lg bg-osu-pink/15 text-[11px] font-medium text-osu-pink-light hover:bg-osu-pink/25 transition-colors cursor-pointer"
              >
                Clear player filter
              </button>
            )}
            <div className="flex items-center justify-between gap-1">
              <div className="flex flex-shrink-0 overflow-hidden rounded-lg border border-osu-b3/25">
                {filters.map((item) => (
                  <button
                    key={item.id}
                    onClick={() => { setFilter(item.id); if (item.id !== "all") setGradeFilter("all"); updateTrackerSearch({ page: 0 }); }}
                    className={`px-2 py-1.5 text-[11px] font-semibold cursor-pointer transition-colors duration-[120ms] ${
                      filter === item.id && gradeFilter === "all"
                        ? "bg-osu-pink/15 text-osu-pink-light"
                        : "bg-osu-b4/50 text-osu-f1 hover:text-osu-l2"
                    }`}
                  >
                    {item.id === "all" ? "All" : item.id === "ranked" ? "PP" : "Pass"}
                  </button>
                ))}
                <button
                  onClick={() => cycleMissFilter(1)}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    cycleMissFilter(-1);
                  }}
                  title={missButtonTitle}
                  className={`w-8 py-1.5 text-[11px] font-semibold cursor-pointer transition-colors duration-[120ms] ${
                    missFilter === "fc"
                      ? "bg-osu-pink/15 text-osu-pink-light"
                      : missFilter === "fc_choke"
                        ? "bg-osu-yellow/15 text-osu-yellow"
                        : "bg-osu-b4/50 text-osu-f1 hover:text-osu-l2"
                  }`}
                >
                  {mobileMissButtonLabel}
                </button>
              </div>
              <div className="flex flex-1 min-w-0 items-center justify-center gap-1">
                {grades.filter((g) => g.id !== "all").map((item) => (
                  <button
                    key={item.id}
                    onClick={() => {
                      if (gradeFilter === item.id) { setGradeFilter("all"); }
                      else { setGradeFilter(item.id); setFilter("all"); }
                      updateTrackerSearch({ page: 0 });
                    }}
                    className={`cursor-pointer transition-all duration-[120ms] ${
                      gradeFilter === item.id
                        ? "opacity-100 scale-110"
                        : gradeFilter === "all"
                          ? "opacity-60"
                          : "opacity-30"
                    }`}
                  >
                    <GradeImg grade={item.id} size={32} />
                  </button>
                ))}
              </div>
              <button
                onClick={() => cycleStarSort(1)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  cycleStarSort(-1);
                }}
                title={starSortTitle}
                className={`flex-shrink-0 cursor-pointer rounded-lg border px-2 py-1.5 text-[11px] font-semibold transition-colors duration-[120ms] ${
                  trackerSort === "stars"
                    ? "border-osu-pink/30 bg-osu-pink/15 text-osu-pink-light"
                    : "border-osu-b3/25 bg-osu-b4/50 text-osu-f1 hover:text-osu-l2"
                }`}
              >
                Stars{trackerSort === "stars" ? (trackerSortDirection === "desc" ? " ↓" : " ↑") : ""}
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="relative z-10">
        <div className="max-w-[1200px] mx-auto px-5 py-5 flex flex-col lg:flex-row gap-4 lg:gap-5">
          {activePlayers.length > 0 && (
            <>
              {/* Mobile: horizontal row */}
              <div className="lg:hidden flex items-center gap-3 overflow-x-auto scrollbar-hide py-1">
                <span className="text-[9px] uppercase tracking-wider text-osu-f1 font-semibold flex-shrink-0">Playing</span>
                {activePlayers.map((player) => (
                  <button
                    key={player.id}
                    onClick={() => {
                      if (player.simulated) return;
                      togglePlayerFilter(player.id);
                    }}
                    onContextMenu={(event) => {
                      event.preventDefault();
                    }}
                    aria-pressed={!player.simulated && selectedPlayerIdSet.has(player.id)}
                    className="cursor-pointer group relative flex-shrink-0"
                    title={player.simulated ? `${player.username} - simulated dev traffic` : `${player.username} - click to filter`}
                  >
                    <div className={`ring-2 ring-inset rounded-full transition-all ${
                      selectedPlayerIdSet.has(player.id)
                        ? "ring-osu-pink shadow-[0_0_0_3px_rgba(255,102,171,0.18)]"
                        : "ring-osu-pink/40 group-hover:ring-osu-pink"
                    }`}>
                      <Avatar url={player.avatar_url} size={32} />
                    </div>
                  </button>
                ))}
              </div>
              {/* Desktop: vertical sidebar, two columns, edge-faded internal scroll */}
              <div className="hidden lg:flex sticky top-[76px] max-h-[calc(100svh_-_196px)] self-start flex-col flex-shrink-0">
                <div className="flex items-baseline justify-between gap-2 mb-2 px-0.5">
                  <span className="text-[9px] uppercase tracking-wider text-osu-f1 font-semibold">Playing</span>
                  <span className="text-[9px] tabular-nums text-osu-f1/70 font-semibold">{activePlayers.length}</span>
                </div>
                <div
                  ref={activeRailRef}
                  onScroll={updateRailFade}
                  className={`min-h-0 overflow-y-auto overscroll-contain scrollbar-hide ${railMaskClass}`}
                >
                  <div className="grid grid-cols-2 gap-2 place-items-center px-0.5 py-1">
                    {activePlayers.map((player) => (
                      <button
                        key={player.id}
                        onClick={() => {
                          if (player.simulated) return;
                          togglePlayerFilter(player.id);
                        }}
                        onContextMenu={(event) => {
                          event.preventDefault();
                        }}
                        aria-pressed={!player.simulated && selectedPlayerIdSet.has(player.id)}
                        className="cursor-pointer group relative shrink-0"
                        title={player.simulated ? `${player.username} - simulated dev traffic` : `${player.username} - click to filter`}
                      >
                        <div className={`ring-2 rounded-full transition-all ${
                          selectedPlayerIdSet.has(player.id)
                            ? "ring-osu-pink shadow-[0_0_0_3px_rgba(255,102,171,0.18)]"
                            : "ring-osu-pink/40 group-hover:ring-osu-pink"
                        }`}>
                          <Avatar url={player.avatar_url} size={32} />
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </>
          )}
          <div className="flex-1 min-w-0">
            {(!initialLoadedForSelectedCountry && feedScores.length === 0) || showingLivePageSkeletons ? (
              <>
                <div className="space-y-2">
                  {Array.from({ length: 6 }).map((_, i) => (
                    <TrackerRowSkeleton key={i} />
                  ))}
                </div>
                {showingLivePageSkeletons && (
                  <Pagination
                    page={currentPage}
                    totalPages={totalPages}
                    onPageChange={(nextPage) => updateTrackerSearch({ page: nextPage })}
                  />
                )}
              </>
            ) : (
              <>
                <VirtualScoreList
                  listKey={`${listKey}:${currentPage}`}
                  entries={feedEntries}
                  timeTick={timeTick}
                  expandedKey={expandedKey}
                  onToggle={handleToggleExpand}
                  expandedMultiKeys={expandedMultiKeys}
                  onToggleMulti={handleToggleMulti}
                  ppGainByScoreId={ppGainByScoreId}
                  showCountryFlag={selectedIsMultiCountry}
                />
                <Pagination
                  page={currentPage}
                  totalPages={totalPages}
                  onPageChange={(nextPage) => updateTrackerSearch({ page: nextPage })}
                />
                {filtered.length === 0 && (
                  feedScores.length === 0 && liveBackendEnabled ? (
                    <LiveDataEmptyState country={selectedCountry} kind="scores" />
                  ) : (
                    <div className="text-center py-16 text-osu-f1 text-sm">
                      {feedScores.length === 0
                        ? "No recent scores yet."
                        : "No scores match this filter"}
                    </div>
                  )
                )}
              </>
            )}
          </div>
        </div>
      </div>
      </div>
      )}
    </div>
  );
}

// Window-virtualized score list. Only mounts the items currently in the
// viewport (plus a small overscan), so mount cost stays roughly constant
// regardless of how many scores are in the feed.
//
// scrollMargin is set to the list container's offsetTop so the virtualizer
// knows where the list starts relative to the window scroll. measureElement
// handles variable item heights (collapsed vs expanded). The outer div gets
// position: relative and a fixed total height so the page scrollbar reflects
// the full list even though only a few items are rendered.
const ESTIMATED_ROW_HEIGHT = 80;
const ignoreVirtualizerScrollCorrection = () => false;

function VirtualScoreList({
  listKey,
  entries,
  timeTick,
  expandedKey,
  onToggle,
  expandedMultiKeys,
  onToggleMulti,
  ppGainByScoreId,
  showCountryFlag,
}: {
  listKey: string;
  entries: TrackerFeedEntry[];
  timeTick: number;
  expandedKey: string | null;
  onToggle: (key: string) => void;
  expandedMultiKeys: ReadonlySet<string>;
  onToggleMulti: (key: string) => void;
  ppGainByScoreId: Record<number, number>;
  showCountryFlag: boolean;
}) {
  const parentRef = useRef<HTMLDivElement>(null);
  const scrollMargin = parentRef.current?.offsetTop ?? 0;

  const virtualizer = useWindowVirtualizer({
    count: entries.length,
    estimateSize: () => ESTIMATED_ROW_HEIGHT,
    overscan: 4,
    scrollMargin,
    useAnimationFrameWithResizeObserver: true,
    // Include the 8px gap (space-y-2) in the item's measured size via a
    // wrapper padding, so the virtualizer's offsets stay correct.
    getItemKey: (index) => entries[index].key,
  });
  // Score detail expansion is a click-driven resize in visible rows; scroll
  // correction here causes one-frame jumps while the accordion swaps rows.
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = ignoreVirtualizerScrollCorrection;

  // Track which entry keys we've already shown so only entries that are genuinely
  // new to the feed get the entrance cue. Rows that mount because the user
  // scrolled them into view are already "seen" and stay still. A null seen-set
  // means first paint; a listKey change (filter/page swap) resets it so the
  // whole new slice arrives without animating.
  const seenKeysRef = useRef<Set<string> | null>(null);
  const prevListKeyRef = useRef(listKey);
  const isResetRender = prevListKeyRef.current !== listKey;
  const animatedKeys = useMemo(() => {
    const seen = seenKeysRef.current;
    if (isResetRender || seen === null) return EMPTY_KEY_SET;
    const fresh = new Set<string>();
    for (const entry of entries) {
      if (!seen.has(entry.key)) fresh.add(entry.key);
    }
    return fresh;
  }, [entries, isResetRender]);

  useEffect(() => {
    const seen = isResetRender || seenKeysRef.current === null ? new Set<string>() : seenKeysRef.current;
    for (const entry of entries) seen.add(entry.key);
    seenKeysRef.current = seen;
    prevListKeyRef.current = listKey;
  }, [entries, listKey, isResetRender]);

  const items = virtualizer.getVirtualItems();

  return (
    <div
      key={listKey}
      ref={parentRef}
      style={{
        height: `${virtualizer.getTotalSize()}px`,
        position: "relative",
        width: "100%",
        overflowAnchor: "none",
      }}
    >
      {items.map((vi) => {
        const entry = entries[vi.index];
        return (
          <div
            key={entry.key}
            data-index={vi.index}
            ref={virtualizer.measureElement}
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              width: "100%",
              transform: `translateY(${vi.start - virtualizer.options.scrollMargin}px)`,
              paddingBottom: 8,
            }}
          >
            {entry.kind === "multi" ? (
              <MultiFeedCard
                groupKey={entry.key}
                rounds={entry.rounds}
                timeTick={timeTick}
                expanded={expandedMultiKeys.has(entry.key)}
                onToggleCard={onToggleMulti}
                expandedKey={expandedKey}
                onToggleScore={onToggle}
                ppGainByScoreId={ppGainByScoreId}
                showCountryFlag={showCountryFlag}
                isNew={animatedKeys.has(entry.key)}
              />
            ) : (
              <ScoreFeedItem
                score={entry.score}
                scoreKey={entry.key}
                timeTick={timeTick}
                approxPpGain={ppGainByScoreId[entry.score.id] ?? null}
                expanded={expandedKey === entry.key}
                onToggle={onToggle}
                showCountryFlag={showCountryFlag}
                isNew={animatedKeys.has(entry.key)}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

// A multiplayer-lobby session as one card: collapsed it headlines the lobby's
// latest map and roster; expanded it lists every map the lobby played, each
// with its plays ranked by total score like osu!'s multi results screen.
// Member rows reuse ScoreFeedItem, so per-score expansion, replay links, and
// pp gains keep working inside the card.
const MultiFeedCard = memo(function MultiFeedCard({
  groupKey,
  rounds,
  timeTick,
  expanded,
  onToggleCard,
  expandedKey,
  onToggleScore,
  ppGainByScoreId,
  showCountryFlag,
  isNew,
}: {
  groupKey: string;
  /** The lobby's rounds in play order, each round's plays in finish order. */
  rounds: TrackerMultiRound[];
  timeTick: number;
  expanded: boolean;
  onToggleCard: (key: string) => void;
  expandedKey: string | null;
  onToggleScore: (key: string) => void;
  ppGainByScoreId: Record<number, number>;
  showCountryFlag: boolean;
  isNew: boolean;
}) {
  const latestRound = rounds[rounds.length - 1];
  const sample = latestRound.scores[0];
  const newest = latestRound.scores[latestRound.scores.length - 1];
  // Latest round's results order: total score, like osu!'s multi results.
  const rankedLatest = useMemo(
    () => [...latestRound.scores].sort((a, b) => (getDisplayedTotalScore(b) ?? 0) - (getDisplayedTotalScore(a) ?? 0)),
    [latestRound],
  );
  const winner = rankedLatest[0];
  // Roster across the whole session: latest round's results order first, then
  // players only seen in earlier rounds.
  const rosterNames = useMemo(() => {
    const names = new Set<string>();
    for (const score of rankedLatest) {
      if (score.user?.username) names.add(score.user.username);
    }
    for (let i = rounds.length - 2; i >= 0; i--) {
      for (const score of rounds[i].scores) {
        if (score.user?.username) names.add(score.user.username);
      }
    }
    return [...names].join(", ");
  }, [rankedLatest, rounds]);
  const keymodeLabel = getBeatmapKeymodeLabel(sample.beatmap);
  const beatmapUrl = getBeatmapUrl(sample);
  const coverUrl = sample.beatmapset?.covers?.["cover@2x"] || sample.beatmapset?.covers?.cover;
  const overflowCount = rankedLatest.length - 4;

  return (
    <div className={`relative rounded-xl bg-osu-b4 border border-osu-purple/25 overflow-hidden${isNew ? " score-enter" : ""}`}>
      {/* Backdrop scoped to the header: expanded rounds get their own map's
          cover below, so the latest map's art must not bleed over them. */}
      <div className="relative">
        {coverUrl && <CoverBackdrop url={coverUrl} opacityClass="opacity-[0.06]" />}
      <div
        className="relative flex items-center gap-2 sm:gap-3 py-3 px-3 sm:px-4 hover:bg-osu-b3/50 transition-colors duration-[120ms] cursor-pointer"
        onClick={() => onToggleCard(groupKey)}
      >
        <div className="flex -space-x-2.5 flex-shrink-0">
          {rankedLatest.slice(0, 4).map((score) => (
            <div key={getScoreIdentity(score)} className="rounded-full ring-2 ring-osu-b4" title={score.user?.username}>
              <Avatar url={score.user?.avatar_url} size={30} />
            </div>
          ))}
          {overflowCount > 0 && (
            <div className="w-[30px] h-[30px] rounded-full bg-osu-b3 ring-2 ring-osu-b4 flex items-center justify-center text-[9px] font-bold text-osu-f1">
              +{overflowCount}
            </div>
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <span
                className="inline-flex items-center gap-1 pl-1.5 pr-2 py-0.5 rounded-full bg-osu-purple/15 ring-1 ring-inset ring-osu-purple/40 text-osu-purple-light flex-shrink-0 cursor-help"
                title="These players finished the same maps within seconds of each other, repeatedly: a multiplayer lobby"
              >
                <svg viewBox="0 0 16 16" className="w-2.5 h-2.5 fill-current" aria-hidden>
                  <circle cx="5.5" cy="4.6" r="2.4" />
                  <rect x="2" y="8.2" width="7" height="6" rx="3" />
                  <g opacity=".55">
                    <circle cx="11.8" cy="5" r="2" />
                    <rect x="9.2" y="8.8" width="5.8" height="5.2" rx="2.6" />
                  </g>
                </svg>
                <span className="text-[8px] font-bold tracking-wide leading-none">MULTI</span>
              </span>
              {beatmapUrl ? (
                <a
                  href={beatmapUrl}
                  target="_blank"
                  rel="noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  className="text-sm font-semibold text-white truncate hover:text-osu-pink-light underline-offset-2 hover:underline"
                  title="Open beatmap on osu!"
                >
                  {sample.beatmapset?.title}
                </a>
              ) : (
                <span className="text-sm font-semibold text-white truncate">{sample.beatmapset?.title}</span>
              )}
              <span className="text-[10px] text-osu-f1 truncate hidden sm:inline">[{sample.beatmap?.version}]</span>
              {keymodeLabel && (
                <span className="px-1 py-0.5 rounded text-[8px] font-bold bg-osu-b3/50 text-osu-yellow flex-shrink-0">
                  {keymodeLabel}
                </span>
              )}
              <span className="hidden sm:inline flex-shrink-0"><DanBadge score={winner} /></span>
            </div>
            <span className="text-[10px] text-osu-f1 flex-shrink-0 sm:hidden">{formatTimeAgo(getScoreTimestamp(newest))}</span>
          </div>
          <div className="text-[10px] text-osu-f1 mt-0.5 truncate">
            {rounds.length > 1 ? `${rounds.length} maps · ` : ""}{rosterNames}
          </div>
        </div>
        <div className="hidden sm:flex items-center gap-3 flex-shrink-0">
          <span className="text-[10px] font-bold text-osu-yellow tabular-nums">#1</span>
          <span className={`text-xs ${isLazerScore(winner) ? "text-osu-pink-light" : "text-osu-l2"}`}>
            {formatAccuracy(getDisplayedAccuracy(winner))}
          </span>
          <span className="text-sm font-bold">{formatPP(winner.pp)}</span>
          <span className="text-[10px] text-osu-f1 w-12 text-right">
            {formatTimeAgo(getScoreTimestamp(newest))}
          </span>
        </div>
        <span
          className={`flex-shrink-0 text-[10px] text-osu-purple-light transition-transform duration-[120ms] ${expanded ? "rotate-180" : ""}`}
          aria-hidden
        >
          {"▾"}
        </span>
      </div>
      </div>
      {expanded && (
        <div className="relative border-t border-osu-b3/30 detail-enter">
          {rounds.map((round, roundIndex) => ({ round, number: roundIndex + 1 })).reverse().map(({ round, number }) => {
            const rankedRound = [...round.scores].sort((a, b) => (getDisplayedTotalScore(b) ?? 0) - (getDisplayedTotalScore(a) ?? 0));
            const roundSample = round.scores[0];
            const roundNewest = round.scores[round.scores.length - 1];
            const roundUrl = getBeatmapUrl(roundSample);
            const roundCover = roundSample.beatmapset?.covers?.list;
            const roundBackdropUrl = roundSample.beatmapset?.covers?.["cover@2x"] || roundSample.beatmapset?.covers?.cover;
            const roundKeymode = getBeatmapKeymodeLabel(roundSample.beatmap);
            return (
              <div key={round.key} className="relative">
                {roundBackdropUrl && <CoverBackdrop url={roundBackdropUrl} opacityClass="opacity-[0.06]" />}
                <div className="relative flex items-center gap-2 px-3 sm:px-4 py-1.5 bg-osu-b3/25 border-b border-osu-b3/20">
                  <span className="text-[9px] uppercase tracking-wider font-semibold text-osu-purple-light/80 tabular-nums flex-shrink-0">
                    Map {number}
                  </span>
                  {roundCover && (
                    <img src={roundCover} alt="" className="w-6 h-6 rounded object-cover flex-shrink-0" loading="lazy" />
                  )}
                  {roundUrl ? (
                    <a
                      href={roundUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-xs text-white truncate hover:text-osu-pink-light underline-offset-2 hover:underline"
                      title="Open beatmap on osu!"
                    >
                      {roundSample.beatmapset?.title}
                    </a>
                  ) : (
                    <span className="text-xs text-white truncate">{roundSample.beatmapset?.title}</span>
                  )}
                  <span className="text-[10px] text-osu-f1 truncate">[{roundSample.beatmap?.version}]</span>
                  {roundKeymode && (
                    <span className="px-1 py-0.5 rounded text-[8px] font-bold bg-osu-b3/50 text-osu-yellow flex-shrink-0">
                      {roundKeymode}
                    </span>
                  )}
                  <span className="ml-auto text-[10px] text-osu-f1 flex-shrink-0">
                    {formatTimeAgo(getScoreTimestamp(roundNewest))}
                  </span>
                </div>
                {rankedRound.map((score, index) => {
                  const memberKey = getScoreIdentity(score);
                  return (
                    <div key={memberKey} className={`relative${index > 0 ? " border-t border-osu-b3/15" : ""}`}>
                      <ScoreFeedItem
                        score={score}
                        scoreKey={memberKey}
                        timeTick={timeTick}
                        approxPpGain={ppGainByScoreId[score.id] ?? null}
                        expanded={expandedKey === memberKey}
                        onToggle={onToggleScore}
                        showCountryFlag={showCountryFlag}
                        isNew={false}
                        embedded
                        placement={index + 1}
                      />
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
});

const ScoreFeedItem = memo(function ScoreFeedItem({
  score,
  scoreKey,
  timeTick: _timeTick,
  approxPpGain,
  expanded,
  onToggle,
  showCountryFlag,
  isNew,
  embedded = false,
  placement = null,
}: {
  score: LeanTrackerScore;
  scoreKey: string;
  timeTick: number;
  approxPpGain: number | null;
  expanded: boolean;
  onToggle: (key: string) => void;
  showCountryFlag: boolean;
  isNew: boolean;
  /** Rendered inside a multi-lobby card: no card chrome, no beatmap line. */
  embedded?: boolean;
  /** Lobby results placement (1 = round winner); only set when embedded. */
  placement?: number | null;
}) {
  const navigate = useNavigate();

  // The profile can only show osu!'s `last_visit`, which ignores gameplay. This
  // play is proof the player was at their keyboard, so hand it over on the way.
  const openPlayerProfile = () => {
    if (!score.user?.username) return;
    seedPlayerRecentPlay(score.user.username, getScoreTimestamp(score));
    navigate({
      to: "/player/$username",
      params: { username: score.user.username },
      ...(showCountryFlag ? { state: showPlayerCountryFlagState } : {}),
    });
  };

  const keymodeLabel = getBeatmapKeymodeLabel(score.beatmap);
  const totalScore = getDisplayedTotalScore(score);
  const beatmapUrl = getBeatmapUrl(score);
  const scoreUrl = getScoreUrl(score);
  const judgementStats = getManiaJudgementStats(score);
  const lazer = isLazerScore(score);
  const accColorClass = lazer ? "text-osu-pink-light" : "text-osu-l2";
  const canReplay = scoreHasReplay(score);
  const showPpGain = approxPpGain != null && approxPpGain >= 0.05;

  return (
    <div className={embedded ? "overflow-hidden" : `rounded-xl bg-osu-b4 border border-osu-b3/20 overflow-hidden${isNew ? " score-enter" : ""}`}>
      <div
        className={`flex items-center gap-2 sm:gap-3 px-3 sm:px-4 hover:bg-osu-b3/50 transition-colors duration-[120ms] cursor-pointer ${embedded ? "py-2" : "py-3"}`}
        onClick={() => onToggle(scoreKey)}
      >
        {placement != null && (
          <span
            className={`w-6 text-center text-xs font-bold tabular-nums flex-shrink-0 ${
              placement === 1 ? "text-osu-yellow" : placement === 2 ? "text-osu-l2" : "text-osu-f1"
            }`}
          >
            #{placement}
          </span>
        )}
        <GradeImg grade={getDisplayedRank(score)} size={32} />
        <button
          onClick={(e) => {
            e.stopPropagation();
            openPlayerProfile();
          }}
          className="cursor-pointer"
          title={score.user?.username ? `Open ${score.user.username}'s profile` : undefined}
        >
          <Avatar url={score.user?.avatar_url} size={36} />
        </button>
        <div className="flex-1 min-w-0">
          {/* Row 1: Username + time (mobile) */}
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              {score.user?.username ? (
                            <div className="flex items-center gap-2 min-w-0">
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  openPlayerProfile();
                                }}
                                className="cursor-pointer min-w-0"
                              >
                                <UsernameText
                                  username={score.user.username}
                                  avatarUrl={score.user?.avatar_url}
                                  className="text-sm font-semibold truncate"
                                />
                              </button>
                              {showCountryFlag && score.user.country_code ? (
                                <CountryFlag code={score.user.country_code} size="sm" />
                              ) : null}
                            </div>
              ) : (
                <UsernameText
                  username="Unknown"
                  avatarUrl={score.user?.avatar_url}
                  className="text-sm font-semibold"
                />
              )}
            </div>
            <span className="text-[11px] text-osu-f1 flex-shrink-0 sm:hidden">{formatTimeAgo(getScoreTimestamp(score))}</span>
          </div>
          {/* Row 2: Beatmap title + keys (the multi card shows the map once in
              its header, so embedded member rows skip it) */}
          {!embedded && (
            <div className="flex items-center justify-between sm:justify-start gap-2 mt-0.5">
              <div className="flex items-center gap-2 min-w-0">
                {beatmapUrl ? (
                  <a
                    href={beatmapUrl}
                    target="_blank"
                    rel="noreferrer"
                    onClick={(e) => e.stopPropagation()}
                    className="text-xs text-white truncate hover:text-osu-pink-light underline-offset-2 hover:underline"
                    title="Open beatmap on osu!"
                  >
                    {score.beatmapset?.title}
                  </a>
                ) : (
                  <span className="text-xs text-white truncate">{score.beatmapset?.title}</span>
                )}
                <span className="text-[11px] text-osu-f1 truncate">[{score.beatmap?.version}]</span>
              </div>
              {keymodeLabel && (
                <span className="px-1 py-0.5 rounded text-[8px] font-bold bg-osu-b3/50 text-osu-yellow flex-shrink-0">
                  {keymodeLabel}
                </span>
              )}
              <span className="hidden sm:inline flex-shrink-0"><DanBadge score={score} /></span>
            </div>
          )}
          {/* Row 3 (mobile): Mods left, stats right */}
          <div className="flex items-center justify-between gap-2 mt-1 sm:hidden">
            <div className="flex items-center gap-1">
              {getModDisplayList(score.mods).map((m) => (
                <ModBadge key={m.acronym} mod={m.acronym} rate={m.rate} />
              ))}
              <DanBadge score={score} />
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              <span className={`text-xs ${accColorClass}`}>{formatAccuracy(getDisplayedAccuracy(score))}</span>
              <span className="text-sm font-bold">{formatPP(score.pp)}</span>
              {showPpGain && (
                <span className="text-[10px] font-semibold text-osu-green">+{formatPpGain(approxPpGain)}</span>
              )}
              {canReplay && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    navigate({ to: "/replay", search: getReplaySearch(score.id, score.beatmapset?.id) });
                  }}
                  className="px-1.5 py-0.5 rounded bg-osu-pink/20 text-[10px] text-osu-pink-light font-semibold hover:bg-osu-pink/30 transition-colors cursor-pointer"
                  title="Watch replay"
                  aria-label="Watch replay"
                >
                  &#9654;
                </button>
              )}
            </div>
          </div>
        </div>
        {/* Desktop metadata */}
        <div className="hidden sm:flex items-center gap-3 flex-shrink-0">
          <div className="flex gap-0.5">
            {getModDisplayList(score.mods).map((m) => (
              <ModBadge key={m.acronym} mod={m.acronym} rate={m.rate} />
            ))}
          </div>
          <span className={`text-xs ${accColorClass}`}>{formatAccuracy(getDisplayedAccuracy(score))}</span>
          <span className="text-sm font-bold">
            {formatPP(score.pp)}
            {showPpGain && (
              <span
                className="ml-1 text-[11px] font-semibold text-osu-green"
                title="Estimated pp gain from replacing your previous best score on this map"
              >
                (+{formatPpGain(approxPpGain)})
              </span>
            )}
          </span>
          {canReplay && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                navigate({ to: "/replay", search: getReplaySearch(score.id, score.beatmapset?.id) });
              }}
              className="px-2 py-1 rounded bg-osu-pink/20 text-[10px] text-osu-pink-light font-semibold hover:bg-osu-pink/30 transition-colors cursor-pointer"
              title="Watch replay"
            >
              &#9654; Watch
            </button>
          )}
          <span className="text-[11px] text-osu-f1 w-14 text-right">
            {formatTimeAgo(getScoreTimestamp(score))}
          </span>
        </div>
      </div>

      {/* Expanded score details */}
      {expanded && (
        <div
          className="relative overflow-hidden px-4 pb-3 pt-1 border-t border-osu-b3/20 detail-enter"
        >
              {/* Embedded rows sit inside a round section that already shows
                  this map's cover; a second backdrop here would stack on it. */}
              {!embedded && (score.beatmapset?.covers?.["cover@2x"] || score.beatmapset?.covers?.cover) && (
                <CoverBackdrop url={score.beatmapset.covers["cover@2x"] || score.beatmapset.covers.cover} />
              )}
              <div className="relative grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-3 text-center">
                <StatCell label="Score" value={totalScore != null ? formatNumber(totalScore) : "-"} />
                <StatCell label="Combo" value={`${formatNumber(score.max_combo)}x`} />
                {judgementStats.map((judgement, i) => (
                  <StatCell key={judgement.label} label={judgement.label} value={formatNumber(judgement.value)} color={judgement.className} className={JUDGEMENT_MOBILE_ORDER_CLASS[i]} />
                ))}
                {score.beatmap?.difficulty_rating != null && (
                  <StatCell
                    label="Stars"
                    value={<StarRatingBadge stars={score.beatmap.difficulty_rating} size={1.2} />}
                    className="max-sm:order-8"
                  />
                )}
                {score.beatmap?.bpm != null && (
                  <StatCell label="BPM" value={String(Math.round(score.beatmap.bpm))} className="max-sm:order-9" />
                )}
                {/* On mobile (2-col) PP gets its own centered full-width row as the headline stat; on sm+ it's a normal trailing cell. */}
                {score.pp != null && score.pp > 0 && (
                  <StatCell label="PP" value={`${Math.round(score.pp)}pp`} color="text-osu-pink" className="col-span-2 max-sm:order-10 sm:col-span-1" />
                )}
              </div>
              <div className="relative mt-2 flex items-center justify-between gap-2">
                <span className="text-[10px] text-osu-f1">
                  Played on: <span className={lazer ? "text-osu-pink-light" : "text-osu-l2"}>{lazer ? "Lazer" : "Stable"}</span>
                </span>
                {scoreUrl ? (
                  <a
                    href={scoreUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[10px] text-osu-f1 hover:text-osu-pink-light underline-offset-2 hover:underline transition-colors"
                  >
                    View on osu! →
                  </a>
                ) : <span />}
              </div>
        </div>
      )}
    </div>
  );
});

// Judgement cells render in canonical [MAX, 300, 200, 100, 50, Miss] DOM order (kept for
// the desktop 4/6-col rows). On the mobile 2-col grid these max-sm orders swap MAX/300 so
// each row pairs like the osu!mania score screen: 300|MAX, 200|100, 50|Miss.
const JUDGEMENT_MOBILE_ORDER_CLASS = [
  "max-sm:order-3",
  "max-sm:order-2",
  "max-sm:order-4",
  "max-sm:order-5",
  "max-sm:order-6",
  "max-sm:order-7",
];

function StatCell({ label, value, color, className }: { label: string; value: ReactNode; color?: string; className?: string }) {
  return (
    <div className={`py-1.5${className ? ` ${className}` : ""}`}>
      <div className="text-[9px] uppercase tracking-wider text-osu-f1 font-semibold">{label}</div>
      <div className={`text-sm font-bold ${color ?? "text-white"}`}>{value}</div>
    </div>
  );
}
