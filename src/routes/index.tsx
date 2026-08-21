import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState, useEffect, useMemo, useRef } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { msg } from "@lingui/core/macro";
import { motion } from "framer-motion";
import { getRankings } from "../lib/osu";
import { CLIENT_CACHE_TTL, isCacheStale } from "../lib/cache";
import { displayCountryName, isGlobalScope } from "../lib/country";
import { useLocale } from "../lib/locale-context";
import { isRegionScope } from "../lib/regions";
import { parseCountrySearchParam, withSearchParams } from "../lib/country-search";
import { formatNumber, formatAccuracy, formatTimeAgo, formatPP } from "../lib/format";
import { getBeatmapKeyCount, getBeatmapKeymodeLabel, getModDisplayList, getScoreDisplayValues, getScoreTimestamp } from "../lib/score";
import { fetchLiveGlobalRankings, fetchLiveRankingsSnapshot, fetchLiveTopPlaysSnapshot, fetchLiveTrackerSnapshot, isLiveBackendConfigured, openLiveEventSource, type LiveGlobalRankingEntry } from "../lib/live-backend";
import { CountryWarming } from "../components/CountryWarming";
import { LiveDataEmptyState } from "../components/LiveDataEmptyState";
import { useCountryWarming } from "../lib/use-country-warming";
import { Avatar } from "../components/ui/Avatar";
import { CountryFlag } from "../components/ui/CountryFlag";
import { GradeImg } from "../components/ui/GradeImg";
import { ModBadge } from "../components/ui/ModBadge";
import { RankingRowSkeleton, ScoreRowSkeleton, Skeleton } from "../components/ui/LoadingSkeleton";
import { ManiaRain } from "../components/home/ManiaRain";
import { UsernameText } from "../components/ui/UsernameText";
import type { RankingsResponse, LeanHomeScore, LeanHomePopoff, LeanTrackerScore, CountryTopPlay, LeanRankingEntry } from "../lib/types";
import { useAppStore, useHasHydrated, useHiddenUserIds, useSelectedCountry } from "../store";
import { DEFAULT_DESCRIPTION, pageSeo } from "../lib/seo";
import { getI18n } from "../lib/i18n";
import { seedPlayerShellFromRankingEntry, seedPlayerShellsFromRankingEntries } from "../lib/player-shell-cache";
import { readGlobalTopPlayersCache, readGlobalTopPlayersMemoryCache, writeGlobalTopPlayersCache } from "../lib/global-top-players-cache";
import { showPlayerCountryFlagState } from "../lib/player-profile-navigation";
import { useWindowActive } from "../lib/window-activity";

// The SSR paint is what crawlers index, so the loader fills the top-players
// panel with real rows server-side instead of skeletons. Both sources sit
// behind short server caches; the budget keeps a slow upstream from stalling
// the whole page render.
const HOME_SNAPSHOT_LOADER_TIMEOUT_MS = 2500;

async function withHomeLoaderBudget<T>(snapshotPromise: Promise<T>): Promise<T | null> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<null>((resolve) => {
    timeoutId = setTimeout(() => resolve(null), HOME_SNAPSHOT_LOADER_TIMEOUT_MS);
  });
  return Promise.race([
    snapshotPromise.finally(() => {
      if (timeoutId) clearTimeout(timeoutId);
    }),
    timeoutPromise,
  ]);
}

// Keyword title: searches are "osu mania tracker" and "o!mania" alone
// doesn't string-match "osu mania", so spell it out before the brand.
const HOME_SEO_TITLE = "osu!mania rankings & live score tracker";
const HOME_SEO_TITLE_MSG = msg`osu!mania rankings & live score tracker`;

type HomeLoaderData = {
  scope: string;
  rankings: RankingsResponse | null;
  globalRanking: LiveGlobalRankingEntry[] | null;
} | null;

export const Route = createFileRoute("/")({
  validateSearch: (search: Record<string, unknown>) => ({
    country: parseCountrySearchParam(search.country),
  }),
  loaderDeps: ({ search }) => ({ country: search.country }),
  loader: async ({ deps, context }): Promise<HomeLoaderData> => {
    // SSR only: on client navigations the store + effects own the data, so the
    // loader skipping keeps navigation instant and avoids a duplicate fetch.
    if (typeof document !== "undefined") return null;
    const scope = deps.country ?? context.initialCountry;
    try {
      if (isGlobalScope(scope)) {
        const snapshot = await withHomeLoaderBudget(
          fetchLiveGlobalRankings(HOME_GLOBAL_RANKINGS_FETCH_COUNT),
        );
        return snapshot ? { scope, rankings: null, globalRanking: snapshot.ranking } : null;
      }
      if (isRegionScope(scope)) {
        // Regions render the same board-style top players as Global, served
        // from the backend's filtered view of the global board.
        const snapshot = await withHomeLoaderBudget(
          fetchLiveRankingsSnapshot(scope, HOME_GLOBAL_RANKINGS_FETCH_COUNT),
        );
        return snapshot ? { scope, rankings: null, globalRanking: snapshot.ranking } : null;
      }
      const rankings = await withHomeLoaderBudget(
        getRankings({ data: { type: "performance", page: 1, country: scope } }),
      );
      return rankings ? { scope, rankings, globalRanking: null } : null;
    } catch {
      return null;
    }
  },
  head: ({ match }) => {
    const country = match.search.country;
    const countryName = country ? displayCountryName(country, match.context.locale) : null;
    const i18n = getI18n(match.context.locale);
    return pageSeo({
      title: i18n._(HOME_SEO_TITLE_MSG),
      description: countryName
        ? i18n._(msg`Top osu!mania players, live scores, and pp records in ${countryName}`)
        : DEFAULT_DESCRIPTION,
      path: withSearchParams("/", { country }),
      origin: match.context.origin,
      imageTitle: HOME_SEO_TITLE,
      imageCountry: country,
      imageKind: country ? "home" : undefined,
      social: true,
    });
  },
  component: HomePage,
});

function getFeaturedPopoffSpanClass(index: number, total: number): string {
  if (total === 1) {
    return "md:col-span-2 xl:col-span-3";
  }

  if (total === 3 && index === 2) {
    return "md:col-span-2 xl:col-span-1";
  }

  return "";
}

function getFeaturedPopoffGridClass(total: number): string {
  if (total === 1) {
    return "grid grid-cols-1 gap-px bg-osu-b3/15";
  }

  if (total === 2) {
    return "grid grid-cols-1 md:grid-cols-2 gap-px bg-osu-b3/15";
  }

  return "grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-px bg-osu-b3/15";
}

const EMPTY_SCORES: LeanHomeScore[] = [];
const EMPTY_TRACKER_SCORES: LeanTrackerScore[] = [];
const EMPTY_POPOFFS: LeanHomePopoff[] = [];
const HOME_RANKING_SKELETON_MOBILE_COUNT = 5;
const HOME_RANKING_SKELETON_DESKTOP_COUNT = 10;
const HOME_GLOBAL_RANKINGS_FETCH_COUNT = 50;
const HOME_RECENT_SCORES_SKELETON_COUNT = 2;
const HOME_LIVE_RECENT_SNAPSHOT_LIMIT = 20;
const HOME_POPOFFS_CACHE_LIMIT = 200;
const HOME_GLOBAL_POPOFFS_WINDOW_MS = 24 * 60 * 60 * 1000;

// Defined at module scope (not inside HomePage) so the component keeps a stable
// identity across HomePage re-renders. Inline definitions get a fresh function
// each render, which React treats as a new type and remounts, replaying the
// fade-in animation every time another fetch resolves.
function GlobalRankingRow({ entry, index, delayStep }: { entry: LiveGlobalRankingEntry; index: number; delayStep: number }) {
  const navigate = useNavigate();
  const seedPlayerShell = () => {
    if (
      entry.hit_accuracy == null ||
      entry.play_count == null ||
      entry.ranked_score == null ||
      entry.grade_counts == null
    ) {
      return;
    }
    const rankingEntry: LeanRankingEntry = {
      user: {
        ...entry.user,
        is_online: false,
      },
      hit_accuracy: entry.hit_accuracy,
      play_count: entry.play_count,
      pp: entry.pp,
      global_rank: entry.global_rank ?? entry.rank,
      ranked_score: entry.ranked_score,
      grade_counts: entry.grade_counts,
    };
    seedPlayerShellFromRankingEntry(rankingEntry, entry.country_rank);
  };
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ delay: index * delayStep }}
      className="flex items-center gap-3 px-4 py-2.5 hover:bg-osu-b3/50 transition-colors cursor-pointer"
      onClick={() => {
        seedPlayerShell();
        navigate({ to: "/player/$username", params: { username: entry.user.username } });
      }}
    >
      <span className="w-6 shrink-0 text-center text-sm font-bold text-osu-f1 tabular-nums">#{entry.rank}</span>
      <Avatar url={entry.user.avatar_url} userId={entry.user.id} size={30} />
      <UsernameText username={entry.user.username} avatarUrl={entry.user.avatar_url} accent={entry.user.avatar_accent} className="min-w-0 flex-1 truncate text-sm font-medium" />
      <span className="flex w-[22px] shrink-0 justify-center">
        <CountryFlag code={entry.user.country_code} size="sm" />
      </span>
      <span className="w-14 shrink-0 text-right text-xs font-bold tabular-nums">{formatNumber(Math.round(entry.pp))}pp</span>
    </motion.div>
  );
}

function getHomeScoreTimeMs(score: LeanHomeScore): number {
  return new Date(score.timestamp).getTime() || 0;
}

function trackerScoreToHomeScore(score: LeanTrackerScore): LeanHomeScore {
  const display = getScoreDisplayValues(score);
  return {
    id: score.id,
    pp: score.pp,
    displayAcc: display.accuracy,
    displayRank: display.rank,
    isLazer: display.isLazer,
    mods: getModDisplayList(score.mods),
    timestamp: getScoreTimestamp(score),
    title: score.beatmapset.title,
    version: score.beatmap.version,
    keyCount: getBeatmapKeyCount(score.beatmap) ?? 0,
    keymodeLabel: getBeatmapKeymodeLabel(score.beatmap) ?? "",
    beatmapsetId: score.beatmapset.id,
    user: {
      id: score.user.id,
      username: score.user.username,
      avatar_url: score.user.avatar_url,
    },
  };
}

function countryTopPlayToHomePopoff(play: CountryTopPlay): LeanHomePopoff | null {
  const score = play.score;
  if (!score?.beatmap || !score.beatmapset) return null;
  const display = getScoreDisplayValues(score);
  return {
    user: {
      username: play.user.username,
      avatar_url: play.user.avatar_url,
    },
    score: {
      id: score.id,
      pp: score.pp ?? play.pp ?? null,
      displayAcc: display.accuracy,
      displayRank: display.rank,
      isLazer: display.isLazer,
      mods: getModDisplayList(score.mods),
      timestamp: getScoreTimestamp(score) || play.time,
      title: score.beatmapset.title,
      version: score.beatmap.version,
      keyCount: getBeatmapKeyCount(score.beatmap) ?? 0,
      keymodeLabel: getBeatmapKeymodeLabel(score.beatmap) ?? "",
      beatmapsetId: score.beatmapset.id,
      user: {
        id: play.user.id,
        username: play.user.username,
        avatar_url: play.user.avatar_url,
      },
    },
  };
}

function mergeHomeRecentScores(
  homeScores: LeanHomeScore[],
  trackerScores: LeanTrackerScore[],
  limit = 5,
): LeanHomeScore[] {
  const trackerHomeScores = trackerScores
    .filter((score) => getScoreDisplayValues(score).passed)
    .map((score) => trackerScoreToHomeScore(score));
  const seenUsers = new Set<number>();

  return [...trackerHomeScores, ...homeScores]
    .sort((a, b) => getHomeScoreTimeMs(b) - getHomeScoreTimeMs(a))
    .filter((score) => {
      if (seenUsers.has(score.user.id)) return false;
      seenUsers.add(score.user.id);
      return true;
    })
    .slice(0, limit);
}

function getHomePopoffChartKey(popoff: LeanHomePopoff): string {
  const score = popoff.score;
  const modsKey = score.mods
    .map((mod) => `${mod.acronym}:${mod.rate ?? ""}`)
    .join(",");
  return [
    score.user.id,
    score.beatmapsetId ?? score.title,
    score.version,
    score.keyCount,
    modsKey,
  ].join("|");
}

function dedupeHomePopoffs(popoffs: LeanHomePopoff[]): LeanHomePopoff[] {
  const seenCharts = new Set<string>();
  return popoffs.filter((popoff) => {
    const key = getHomePopoffChartKey(popoff);
    if (seenCharts.has(key)) return false;
    seenCharts.add(key);
    return true;
  });
}

function getHomePopoffTimeMs(popoff: LeanHomePopoff): number {
  return new Date(popoff.score.timestamp).getTime() || 0;
}

function isHomeGlobalPopoffRecent(popoff: LeanHomePopoff, now = Date.now()): boolean {
  const timestamp = getHomePopoffTimeMs(popoff);
  return timestamp > 0 && now - timestamp <= HOME_GLOBAL_POPOFFS_WINDOW_MS;
}

function filterHomeGlobalPopoffs(popoffs: LeanHomePopoff[], now = Date.now()): LeanHomePopoff[] {
  return popoffs.filter((popoff) => isHomeGlobalPopoffRecent(popoff, now));
}

function mergeHomePopoffs(popoffs: LeanHomePopoff[], incoming: LeanHomePopoff[]): LeanHomePopoff[] {
  return dedupeHomePopoffs([...incoming, ...popoffs])
    .sort((a, b) => (b.score.pp ?? 0) - (a.score.pp ?? 0) || getHomePopoffTimeMs(b) - getHomePopoffTimeMs(a))
    .slice(0, HOME_POPOFFS_CACHE_LIMIT);
}

function getHomePopoffUserKey(popoff: LeanHomePopoff): string {
  return String(popoff.score.user.id || popoff.user.username);
}

function selectFeaturedHomePopoffs(popoffs: LeanHomePopoff[], limit = 3): LeanHomePopoff[] {
  const chartDeduped = dedupeHomePopoffs(popoffs);
  const selected: LeanHomePopoff[] = [];
  const selectedKeys = new Set<string>();
  const seenUsers = new Set<string>();

  for (const popoff of chartDeduped) {
    const userKey = getHomePopoffUserKey(popoff);
    if (seenUsers.has(userKey)) continue;
    selected.push(popoff);
    selectedKeys.add(String(popoff.score.id));
    seenUsers.add(userKey);
    if (selected.length >= limit) return selected;
  }

  for (const popoff of chartDeduped) {
    const scoreKey = String(popoff.score.id);
    if (selectedKeys.has(scoreKey)) continue;
    selected.push(popoff);
    if (selected.length >= limit) return selected;
  }

  return selected;
}

function HomePage() {
  const { t } = useLingui();
  const locale = useLocale();
  const navigate = useNavigate();
  const { country } = Route.useSearch();
  const loaderData = Route.useLoaderData();
  const fallbackCountry = useSelectedCountry();
  const selectedCountry = country ?? fallbackCountry;
  const selectedIsGlobal = isGlobalScope(selectedCountry);
  const selectedIsRegion = isRegionScope(selectedCountry);
  // Global and regions share the board-style "Top players" panel; countries
  // render the osu! API leaderboard.
  const boardScope = selectedIsGlobal || selectedIsRegion;
  // SSR fallback: renders real rows on the server paint (what crawlers index)
  // and until the client fetches land. Scope-guarded so a post-hydration
  // country switch never shows the previous scope's board.
  const loaderSnapshot = loaderData?.scope === selectedCountry ? loaderData : null;
  const hydrated = useHasHydrated();
  const storeRankings = useAppStore((state) => state.rankingsByCountry[selectedCountry] ?? null);
  const rankingsFetchedAt = useAppStore((state) => state.rankingsFetchedAtByCountry[selectedCountry] ?? null);
  // Persist reads localStorage synchronously, so the store already holds the
  // board an earlier visit cached by the time React runs the hydration render.
  // The loader board is the one the server painted and it was fetched for this
  // request, so it keeps the panel until a client fetch actually lands. Reading
  // the cached board any sooner mismatches the SSR usernames (React throws the
  // whole panel away and re-renders it) and trades fresh rows for older ones.
  const mountedAt = useRef(Date.now());
  const storeRankingsAreNewer = rankingsFetchedAt != null && rankingsFetchedAt >= mountedAt.current;
  const rankings = (hydrated && (storeRankingsAreNewer || !loaderSnapshot?.rankings) ? storeRankings : null)
    ?? loaderSnapshot?.rankings
    ?? null;
  const recentScores = useAppStore((state) => state.homeRecentScoresByCountry[selectedCountry]) ?? EMPTY_SCORES;
  const recentScoresFetchedAt = useAppStore((state) => state.homeRecentScoresFetchedAtByCountry[selectedCountry]) ?? null;
  const trackerFeedScores = useAppStore((state) => state.feedScoresByCountry[selectedCountry]) ?? EMPTY_TRACKER_SCORES;
  const popoffs = useAppStore((state) => state.homePopoffsByCountry[selectedCountry]) ?? EMPTY_POPOFFS;
  const popoffsFetchedAt = useAppStore((state) => state.homePopoffsFetchedAtByCountry[selectedCountry]) ?? null;
  const topPlaysRange = useAppStore((state) => state.topPlaysRangeByCountry[selectedCountry] ?? "7d");
  const liveBackendEnabled = isLiveBackendConfigured();
  const windowActive = useWindowActive();
  const { warming } = useCountryWarming(selectedCountry);
  const hiddenUserIds = useHiddenUserIds();
  const setRankings = useAppStore((state) => state.setRankings);
  const setHomeRecentScores = useAppStore((state) => state.setHomeRecentScores);
  const setHomePopoffs = useAppStore((state) => state.setHomePopoffs);
  const addFeedScores = useAppStore((state) => state.addFeedScores);
  const markFeedScoresFetched = useAppStore((state) => state.markFeedScoresFetched);
  const [rankingsError, setRankingsError] = useState<string | null>(null);
  const [globalTopPlayers, setGlobalTopPlayers] = useState<LiveGlobalRankingEntry[] | null>(
    () => readGlobalTopPlayersMemoryCache()?.data ?? null,
  );
  const [loadingScores, setLoadingScores] = useState(recentScores.length === 0);
  // On Global the card renders the 24h-filtered set, not the raw array, so base
  // "is there anything to show" on the filtered count. Otherwise a refresh with
  // cached-but-aged entries reads loading=false against a non-empty array while
  // the visible (filtered) list is empty, flashing "No recent top plays" until
  // the fetch lands. Driving the skeleton off the displayable count keeps it
  // stale-while-revalidate instead.
  const displayablePopoffsCount = (selectedIsGlobal ? filterHomeGlobalPopoffs(popoffs) : popoffs).length;
  const [loadingPopoffs, setLoadingPopoffs] = useState(() => displayablePopoffsCount === 0);
  const countryName = displayCountryName(selectedCountry, locale);
  const homeTopPlaysRange = selectedIsGlobal ? "24h" : hydrated ? topPlaysRange : "7d";

  useEffect(() => {
    let cancelled = false;
    // Global and regions have no single-country leaderboard; their live
    // sections (recent scores, popoffs) load from the aggregated snapshots.
    if (boardScope) {
      setRankingsError(null);
      return () => {
        cancelled = true;
      };
    }
    const shouldRefreshRankings = !rankings || isCacheStale(rankingsFetchedAt, CLIENT_CACHE_TTL.rankings);

    if (!shouldRefreshRankings) {
      setRankingsError(null);
      return () => {
        cancelled = true;
      };
    }

    getRankings({ data: { type: "performance", page: 1, country: selectedCountry } })
      .then((data) => {
        if (cancelled) return;
        setRankings(selectedCountry, data);
        setRankingsError(null);
      })
      .catch(() => {
        if (cancelled || rankings) return;
        setRankingsError(t`Couldn't load the ${countryName} rankings right now.`);
        setLoadingScores(false);
        setLoadingPopoffs(false);
      });

    return () => {
      cancelled = true;
    };
  // Only depend on lengths and timestamps, never on array/object references.
  // The effect only needs to know *whether* data exists and *how stale* it is.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    rankings,
    rankingsFetchedAt,
    selectedCountry,
    countryName,
    setRankings,
  ]);

  useEffect(() => {
    if (!rankings) return;
    seedPlayerShellsFromRankingEntries(rankings.ranking, 1);
  }, [rankings]);

  // Global's left panel shows the combined top players (the same board as the
  // Rankings page), instead of a single country's leaderboard. A region shows
  // its filtered board the same way (uncached: the persistent cache is the
  // global board's alone).
  useEffect(() => {
    if (!boardScope) return;
    let cancelled = false;
    if (!selectedIsGlobal) {
      setGlobalTopPlayers(null);
      fetchLiveRankingsSnapshot(selectedCountry, HOME_GLOBAL_RANKINGS_FETCH_COUNT)
        .then((snapshot) => { if (!cancelled) setGlobalTopPlayers(snapshot.ranking); })
        .catch(() => { if (!cancelled) setGlobalTopPlayers((prev) => prev ?? []); });
      return () => { cancelled = true; };
    }
    // Serve the cached board immediately; only hit the network when it's missing
    // or past the TTL. Keep showing the cached board while refreshing so the card
    // never flips back to a skeleton on revisits.
    const cached = readGlobalTopPlayersCache();
    const fresh = cached && !isCacheStale(cached.fetchedAt, CLIENT_CACHE_TTL.rankings);
    if (cached) setGlobalTopPlayers(cached.data);
    if (fresh) return;
    fetchLiveGlobalRankings(HOME_GLOBAL_RANKINGS_FETCH_COUNT)
      .then((snapshot) => {
        writeGlobalTopPlayersCache(snapshot.ranking);
        if (!cancelled) setGlobalTopPlayers(snapshot.ranking);
      })
      .catch(() => { if (!cancelled) setGlobalTopPlayers((prev) => prev ?? []); });
    return () => { cancelled = true; };
  }, [boardScope, selectedCountry, selectedIsGlobal]);

  useEffect(() => {
    let cancelled = false;
    if (!liveBackendEnabled) {
      setLoadingScores(false);
      return () => {
        cancelled = true;
      };
    }
    const shouldRefreshScores =
      !recentScoresFetchedAt || isCacheStale(recentScoresFetchedAt, CLIENT_CACHE_TTL.homeRecentScores);

    if (!shouldRefreshScores) {
      setLoadingScores(false);
      return () => {
        cancelled = true;
      };
    }

    // An unfocused tab defers refreshes, but the initial fill still runs so a
    // page opened in the background doesn't sit on skeletons until focus.
    if (!windowActive && recentScores.length > 0) {
      setLoadingScores(false);
      return () => {
        cancelled = true;
      };
    }

    setLoadingScores(recentScores.length === 0);
    fetchLiveTrackerSnapshot(selectedCountry, HOME_LIVE_RECENT_SNAPSHOT_LIMIT)
      .then((snapshot) => {
        if (cancelled) return;
        const passedScores = snapshot.scores.filter((score) => getScoreDisplayValues(score).passed);
        setHomeRecentScores(selectedCountry, passedScores.map(trackerScoreToHomeScore));
        if (passedScores.length > 0) addFeedScores(selectedCountry, passedScores);
        else markFeedScoresFetched(selectedCountry);
      })
      .catch(() => {
        if (cancelled) return;
      })
      .finally(() => {
        if (cancelled) return;
        setLoadingScores(false);
      });

    return () => {
      cancelled = true;
    };
  // Only depend on lengths and timestamps, never on array/object references.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    recentScores.length,
    recentScoresFetchedAt,
    selectedCountry,
    setHomeRecentScores,
    addFeedScores,
    markFeedScoresFetched,
    liveBackendEnabled,
    windowActive,
  ]);

  // Stays connected while unfocused so the recent-scores strip and popoffs keep
  // updating on a second monitor during play (same rationale as the tracker
  // feed). Snapshot refreshes stay gated on windowActive; only the initial
  // fill runs unfocused.
  useEffect(() => {
    if (!liveBackendEnabled) return;
    const source = openLiveEventSource(selectedCountry);
    if (!source) return;
    source.addEventListener("tracker_score", (event) => {
      const score = JSON.parse(event.data) as LeanTrackerScore;
      if (!getScoreDisplayValues(score).passed) return;
      addFeedScores(selectedCountry, [score]);
      const current = useAppStore.getState().homeRecentScoresByCountry[selectedCountry] ?? EMPTY_SCORES;
      setHomeRecentScores(selectedCountry, mergeHomeRecentScores(current, [score]));
      setLoadingScores(false);
    });
    source.addEventListener("top_play", (event) => {
      const play = JSON.parse(event.data) as CountryTopPlay;
      const popoff = countryTopPlayToHomePopoff(play);
      if (!popoff) return;
      const current = useAppStore.getState().homePopoffsByCountry[selectedCountry] ?? EMPTY_POPOFFS;
      const merged = mergeHomePopoffs(current, [popoff]);
      setHomePopoffs(selectedCountry, selectedIsGlobal ? filterHomeGlobalPopoffs(merged) : merged);
      setLoadingPopoffs(false);
    });
    return () => source.close();
  }, [addFeedScores, liveBackendEnabled, selectedCountry, selectedIsGlobal, setHomePopoffs, setHomeRecentScores]);

  useEffect(() => {
    let cancelled = false;
    if (!liveBackendEnabled) {
      setLoadingPopoffs(false);
      return () => {
        cancelled = true;
      };
    }
    const cachedGlobalPopoffsIncludeOld = selectedIsGlobal && popoffs.some((popoff) => !isHomeGlobalPopoffRecent(popoff));
    const shouldRefreshPopoffs =
      !popoffsFetchedAt || isCacheStale(popoffsFetchedAt, CLIENT_CACHE_TTL.homePopoffs) || cachedGlobalPopoffsIncludeOld;

    if (!shouldRefreshPopoffs) {
      setLoadingPopoffs(false);
      return () => {
        cancelled = true;
      };
    }

    // An unfocused tab defers refreshes, but the initial fill still runs so a
    // page opened in the background doesn't sit on skeletons until focus.
    if (!windowActive && displayablePopoffsCount > 0) {
      setLoadingPopoffs(false);
      return () => {
        cancelled = true;
      };
    }

    setLoadingPopoffs(displayablePopoffsCount === 0);
    fetchLiveTopPlaysSnapshot(selectedCountry, selectedIsGlobal ? "24h" : "7d")
      .then((snapshot) => {
        if (cancelled) return;
        const nextPopoffs = dedupeHomePopoffs(
          snapshot.popoffs
            .map(countryTopPlayToHomePopoff)
            .filter((play): play is LeanHomePopoff => play !== null),
        );
        setHomePopoffs(
          selectedCountry,
          selectedIsGlobal ? filterHomeGlobalPopoffs(nextPopoffs) : nextPopoffs,
        );
      })
      .catch(() => {
        if (cancelled) return;
      })
      .finally(() => {
        if (cancelled) return;
        setLoadingPopoffs(false);
      });

    return () => {
      cancelled = true;
    };
  // Only depend on lengths and timestamps, never on array/object references.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    popoffs.length,
    popoffsFetchedAt,
    selectedCountry,
    selectedIsGlobal,
    setHomePopoffs,
    liveBackendEnabled,
    windowActive,
  ]);

  const visibleRanking = useMemo(
    () => (rankings?.ranking ?? []).filter((entry) => !hiddenUserIds.has(entry.user.id)),
    [rankings, hiddenUserIds],
  );
  const effectiveGlobalTopPlayers = globalTopPlayers ?? loaderSnapshot?.globalRanking ?? null;
  const visibleGlobalTopPlayers = useMemo(
    () => (effectiveGlobalTopPlayers ?? []).filter((entry) => !hiddenUserIds.has(entry.user.id)),
    [effectiveGlobalTopPlayers, hiddenUserIds],
  );
  const topPlayersMobile = visibleRanking.slice(0, 5);
  const topPlayersDesktop = visibleRanking.slice(0, 10);
  const globalTopPlayersMobile = visibleGlobalTopPlayers.slice(0, HOME_RANKING_SKELETON_MOBILE_COUNT);
  const globalTopPlayersDesktop = visibleGlobalTopPlayers.slice(0, HOME_RANKING_SKELETON_DESKTOP_COUNT);
  const featuredPopoffs = useMemo(
    () => {
      const scopedPopoffs = selectedIsGlobal ? filterHomeGlobalPopoffs(popoffs) : popoffs;
      return selectFeaturedHomePopoffs(scopedPopoffs.filter((p) => !hiddenUserIds.has(p.score.user.id)));
    },
    [popoffs, hiddenUserIds, selectedIsGlobal],
  );
  const displayedRecentScores = useMemo(
    () => mergeHomeRecentScores(
      recentScores.filter((s) => !hiddenUserIds.has(s.user.id)),
      trackerFeedScores.filter((s) => !hiddenUserIds.has(s.user_id)),
    ),
    [recentScores, trackerFeedScores, hiddenUserIds],
  );

  return (
    <div className="flex-1 relative overflow-hidden min-h-[calc(100vh-60px)]">
      <div className="absolute inset-0 pointer-events-none">
        <img
          src="/images/layout/nav2-background-hue0.webp"
          alt=""
          className="absolute inset-0 w-full h-full object-cover opacity-15"
          style={{ filter: "hue-rotate(calc(var(--theme-hue) * 1deg)) saturate(calc(0.6 * var(--theme-sat)))", transform: "scale(2.5)", transformOrigin: "center" }}
        />
        <ManiaRain />
      </div>

      {/* Hero */}
      <section className="relative py-8 sm:py-14 px-4 sm:px-5">
        <div className="max-w-[1200px] mx-auto text-center">
          <div className="flex items-center justify-center gap-3">
            <span className="mode-icon text-osu-pink text-3xl sm:text-5xl">{"\ue802"}</span>
            <h1 className="text-3xl sm:text-5xl font-black text-white tracking-tight" style={{ fontFamily: "Torus" }}>mania <span className="text-osu-pink">{selectedIsGlobal ? <Trans>Global</Trans> : selectedIsRegion ? countryName : selectedCountry}</span></h1>
          </div>
        </div>
      </section>

      {warming && <CountryWarming country={selectedCountry} />}

      {!warming && (
      <div className="relative max-w-[1200px] mx-auto px-4 sm:px-5 pb-8 grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-4">
        {/* Country Top players (or Global note) */}
        <section className="min-w-0 bg-osu-b4 rounded-xl border border-osu-b3/20 overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-osu-b3/20">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-osu-f1">{boardScope ? <Trans>Top players</Trans> : <Trans>Rankings</Trans>}</h2>
            <Link to="/rankings" search={{ page: 1, country: selectedCountry }} className="text-[10px] text-osu-pink hover:text-osu-pink-light transition-colors"><Trans>view all</Trans></Link>
          </div>
          {boardScope ? (
            <div className="divide-y divide-osu-b3/15">
              {effectiveGlobalTopPlayers == null ? (
                <>
                  <div className="lg:hidden">
                    {Array.from({ length: HOME_RANKING_SKELETON_MOBILE_COUNT }).map((_, i) => <RankingRowSkeleton key={i} />)}
                  </div>
                  <div className="hidden lg:block">
                    {Array.from({ length: HOME_RANKING_SKELETON_DESKTOP_COUNT }).map((_, i) => <RankingRowSkeleton key={i} />)}
                  </div>
                </>
              ) : visibleGlobalTopPlayers.length > 0 ? (
                <>
                  <div className="lg:hidden">
                    {globalTopPlayersMobile.map((entry, i) => (
                      <GlobalRankingRow key={entry.user.id} entry={entry} index={i} delayStep={0.04} />
                    ))}
                  </div>
                  <div className="hidden lg:block">
                    {globalTopPlayersDesktop.map((entry, i) => (
                      <GlobalRankingRow key={entry.user.id} entry={entry} index={i} delayStep={0.035} />
                    ))}
                  </div>
                </>
              ) : (
                <div className="px-4 py-6 text-center text-xs text-osu-f1"><Trans>No ranked players yet.</Trans></div>
              )}
            </div>
          ) : (
          <div className="divide-y divide-osu-b3/15">
            {rankingsError ? (
              <div className="px-4 py-6 text-center text-xs text-osu-f1">{rankingsError}</div>
            ) : topPlayersMobile.length > 0 ? (
              <>
                <div className="lg:hidden">
                  {topPlayersMobile.map((entry: RankingsResponse["ranking"][number], i: number) => (
                    <motion.div key={entry.user.id} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: i * 0.04 }}
                      className="flex items-center gap-3 px-4 py-2.5 hover:bg-osu-b3/50 transition-colors cursor-pointer"
                      onClick={() => {
                        seedPlayerShellFromRankingEntry(entry, i + 1);
                        navigate({ to: "/player/$username", params: { username: entry.user.username } });
                      }}>
                      <span className="text-sm font-bold text-osu-f1 w-6 text-center">#{i + 1}</span>
                      <Avatar url={entry.user.avatar_url} size={30} />
                      <UsernameText
                        username={entry.user.username}
                        avatarUrl={entry.user.avatar_url}
                        className="text-sm font-medium flex-1 truncate"
                      />
                      <span className="text-xs font-bold text-right">{formatNumber(Math.round(entry.pp))}pp</span>
                    </motion.div>
                  ))}
                </div>
                <div className="hidden lg:block">
                  {topPlayersDesktop.map((entry: RankingsResponse["ranking"][number], i: number) => (
                    <motion.div key={entry.user.id} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: i * 0.035 }}
                      className="flex items-center gap-3 px-4 py-2.5 hover:bg-osu-b3/50 transition-colors cursor-pointer"
                      onClick={() => {
                        seedPlayerShellFromRankingEntry(entry, i + 1);
                        navigate({ to: "/player/$username", params: { username: entry.user.username } });
                      }}>
                      <span className="text-sm font-bold text-osu-f1 w-6 text-center">#{i + 1}</span>
                      <Avatar url={entry.user.avatar_url} size={30} />
                      <UsernameText
                        username={entry.user.username}
                        avatarUrl={entry.user.avatar_url}
                        className="text-sm font-medium flex-1 truncate"
                      />
                      <span className="text-xs font-bold text-right">{formatNumber(Math.round(entry.pp))}pp</span>
                    </motion.div>
                  ))}
                </div>
              </>
            ) : (
              <>
                <div className="lg:hidden">
                  {Array.from({ length: HOME_RANKING_SKELETON_MOBILE_COUNT }).map((_, i) => (
                    <RankingRowSkeleton key={i} />
                  ))}
                </div>
                <div className="hidden lg:block">
                  {Array.from({ length: HOME_RANKING_SKELETON_DESKTOP_COUNT }).map((_, i) => (
                    <RankingRowSkeleton key={i} />
                  ))}
                </div>
              </>
            )}
          </div>
          )}
        </section>

        <div className="min-w-0 flex flex-col gap-4">
        {/* Recent Top Plays - featured */}
        <section className="bg-osu-b4 rounded-xl border border-osu-b3/20 overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-osu-b3/20">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-osu-f1"><Trans>Recent Top Plays</Trans></h2>
            <Link
              to="/top-plays"
              search={{ range: homeTopPlaysRange, country: selectedCountry, sort: "recent", dir: "desc", keys: "all" }}
              className="text-[10px] text-osu-pink hover:text-osu-pink-light transition-colors"
            >
              <Trans>view all</Trans>
            </Link>
          </div>
          {loadingPopoffs ? (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-px bg-osu-b3/15">
              {Array.from({ length: 3 }).map((_, i) => (
                <div
                  key={i}
                  className={`bg-osu-b4 min-h-[180px] p-5 flex flex-col items-center justify-center space-y-3 ${getFeaturedPopoffSpanClass(i, 3)}`}
                >
                  <Skeleton className="h-8 w-20 mx-auto" />
                  <Skeleton className="h-8 w-24 mx-auto" />
                  <Skeleton className="h-3 w-32 mx-auto" />
                  <Skeleton className="h-2.5 w-40 mx-auto" />
                </div>
              ))}
            </div>
          ) : featuredPopoffs.length > 0 ? (
            <div className={getFeaturedPopoffGridClass(featuredPopoffs.length)}>
              {featuredPopoffs.map((p, i) => (
                <motion.div
                  key={p.score.id}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: i * 0.06 }}
                  className={`group bg-osu-b4 min-h-[180px] p-5 cursor-pointer text-center flex flex-col items-center justify-center relative isolate overflow-hidden ${getFeaturedPopoffSpanClass(i, featuredPopoffs.length)}`}
                  onClick={() => navigate({
                    to: "/player/$username",
                    params: { username: p.user.username },
                    ...(boardScope ? { state: showPlayerCountryFlagState } : {}),
                  })}>
                  {p.score.beatmapsetId && (
                    <>
                      <img
                        src={`https://assets.ppy.sh/beatmaps/${p.score.beatmapsetId}/covers/cover.jpg`}
                        alt=""
                        className="absolute inset-0 w-full h-full object-cover opacity-[0.12] group-hover:opacity-[0.25] transition-opacity duration-200 -z-20 pointer-events-none"
                      />
                      <div
                        className="absolute inset-0 -z-20 pointer-events-none"
                        style={{ background: "radial-gradient(ellipse at center, var(--color-osu-b4) 0%, transparent 75%)" }}
                      />
                    </>
                  )}
                  <div className="text-3xl font-bold text-osu-pink leading-none" style={{ fontFamily: "Torus" }}>
                    {Math.round(p.score.pp ?? 0)}pp
                  </div>
                  <div className="mt-3 flex items-center justify-center gap-2 max-w-full">
                    <GradeImg grade={p.score.displayRank} size={18} />
                    <Avatar url={p.user.avatar_url} size={24} />
                    <UsernameText
                      username={p.user.username}
                      avatarUrl={p.user.avatar_url}
                      className="text-xs font-medium max-w-[14ch] truncate"
                    />
                  </div>
                  <div className="mt-3 w-full max-w-[26ch] space-y-1">
                    <div className="text-[11px] text-osu-f1 leading-relaxed line-clamp-2">
                      {p.score.title}
                    </div>
                    <div className="text-[10px] text-osu-f1/80 leading-relaxed line-clamp-2">
                      [{p.score.version}]
                    </div>
                  </div>
                  {p.score.mods.length > 0 && (
                    <div className="mt-3 flex items-center justify-center gap-1 flex-wrap max-w-[26ch]">
                      {p.score.mods.map((m) => (
                        <ModBadge key={m.acronym} mod={m.acronym} rate={m.rate} size={0.8} />
                      ))}
                    </div>
                  )}
                  <div className="mt-3 text-[10px] text-osu-f1/60">{formatTimeAgo(p.score.timestamp, locale)}</div>
                </motion.div>
              ))}
            </div>
          ) : (
            liveBackendEnabled && rankings ? (
              <LiveDataEmptyState country={selectedCountry} kind="top-plays" compact />
            ) : (
              <div className="px-4 py-6 text-center text-xs text-osu-f1"><Trans>No recent top plays</Trans></div>
            )
          )}
        </section>

        {/* Recent Scores */}
        <section className="bg-osu-b4 rounded-xl border border-osu-b3/20 overflow-hidden lg:flex-1">
          <div className="flex items-center justify-between px-4 py-3 border-b border-osu-b3/20">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-osu-f1"><Trans>Recent Scores</Trans></h2>
            <Link to="/tracker" search={{ country: selectedCountry, page: undefined }} className="text-[10px] text-osu-pink hover:text-osu-pink-light transition-colors"><Trans>view all</Trans></Link>
          </div>
          <div className="divide-y divide-osu-b3/15">
            {loadingScores && displayedRecentScores.length === 0 ? (
              Array.from({ length: HOME_RECENT_SCORES_SKELETON_COUNT }).map((_, i) => (
                <div key={i} className="px-4 py-2">
                  <ScoreRowSkeleton />
                </div>
              ))
            ) : displayedRecentScores.length > 0 ? (
              displayedRecentScores.map((s: LeanHomeScore, i: number) => (
                <motion.div key={s.id} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: i * 0.04 }}
                  className="flex items-center gap-3 px-4 py-2.5 hover:bg-osu-b3/50 transition-colors cursor-pointer"
                  onClick={() => navigate({
                    to: "/player/$username",
                    params: { username: s.user.username },
                    ...(boardScope ? { state: showPlayerCountryFlagState } : {}),
                  })}>
                    <GradeImg grade={s.displayRank} size={22} />
                  <Avatar url={s.user.avatar_url} size={26} />
                  <div className="flex-1 min-w-0">
                    <div className="text-xs truncate">
                      <Trans>
                        <UsernameText
                          username={s.user.username}
                          avatarUrl={s.user.avatar_url}
                          className="font-medium"
                        />{" "}
                        <span className="text-osu-f1">on</span> {s.title}
                      </Trans>
                    </div>
                    <div className="mt-0.5 text-[10px] text-osu-f1 min-w-0 truncate">
                        [{s.version}] {s.keymodeLabel || (s.keyCount > 0 ? `${s.keyCount}K` : "")} &middot; {formatTimeAgo(s.timestamp, locale)}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    {s.mods.length > 0 && (
                      <div className="flex items-center gap-0.5">
                        {s.mods.map((m) => (
                          <ModBadge key={m.acronym} mod={m.acronym} rate={m.rate} size={0.8} />
                        ))}
                      </div>
                    )}
                    <span className={`text-xs ${s.isLazer ? "text-osu-pink-light" : "text-osu-l2"}`}>{formatAccuracy(s.displayAcc)}</span>
                    <span className="text-xs font-bold">{formatPP(s.pp)}</span>
                  </div>
                </motion.div>
              ))
            ) : (
              liveBackendEnabled && rankings ? (
                <LiveDataEmptyState country={selectedCountry} kind="scores" compact />
              ) : (
                <div className="px-4 py-6 text-center text-xs text-osu-f1"><Trans>No recent scores</Trans></div>
              )
            )}
          </div>
        </section>
        </div>
      </div>
      )}

    </div>
  );
}
