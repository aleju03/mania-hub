import { createFileRoute, stripSearchParams, useNavigate } from "@tanstack/react-router";
import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { getRankings, getCountryMapsData, rebuildCountryMapsData } from "../lib/osu";
import { CLIENT_CACHE_TTL, isCacheStale } from "../lib/cache";
import { getCountryName } from "../lib/country";
import { formatNumber, formatDuration, formatTimeAgo } from "../lib/format";
import { MANIA_PATTERN_LABELS } from "../lib/mania-patterns";
import { PageHeader } from "../components/layout/PageHeader";
import { PageTabs } from "../components/layout/PageTabs";
import { Avatar } from "../components/ui/Avatar";
import { Skeleton } from "../components/ui/LoadingSkeleton";
import { ModBadge } from "../components/ui/ModBadge";
import { Pagination } from "../components/ui/Pagination";
import type {
  CountryMapsData,
  RankingsResponse,
  MapsAggregatedBeatmap,
  MapsAggregatedFavourite,
  MapsFarmedEntry,
  MapsFarmedPlayer,
  MapsFavouriteBeatmapset,
  MapsPlayerEntry,
  MapsPlayerFavourites,
} from "../lib/types";
import { useAppStore, useSelectedCountry } from "../store";

// ── Types ──────────────────────────────────────────────────────────────────

type Tab = "farmed" | "popular" | "favourites" | "random";
type KeyFilter = "all" | "4k" | "7k" | "other";
type BeatmapSort = "plays" | "players" | "stars" | "length";
type FarmedSort = "players" | "avg-pp" | "max-pp" | "stars";
type StatusFilter = "all" | "ranked" | "loved" | "graveyard" | "other";
type PpFilter = 0 | 500 | 700;
type ModFilter = "all" | "dt" | "ht" | "nm";
type MapsSearch = {
  tab: Tab;
  page: number;
  key: KeyFilter;
  beatmapSort: BeatmapSort;
  farmedSort: FarmedSort;
  status: StatusFilter;
  pp: PpFilter;
  mod: ModFilter;
  q: string;
  rStatus: string;
  rKey: string;
  rPattern: string;
};

const PAGE_SIZE = 24;
const VISIBLE_AVATARS = 4;
const FARMED_SINGLE_PLAYER_PP_MIN = 500;
const DEFAULT_MAPS_SEARCH: MapsSearch = {
  tab: "farmed",
  page: 0,
  key: "all",
  beatmapSort: "players",
  farmedSort: "players",
  status: "all",
  pp: 0,
  mod: "all",
  q: "",
  rStatus: "",
  rKey: "",
  rPattern: "",
};

const RANDOM_STATUS_OPTIONS = ["ranked", "loved", "graveyard", "other"] as const;
const RANDOM_KEY_OPTIONS = ["4k", "7k", "other"] as const;
const RANDOM_PATTERN_OPTIONS = [
  "jack",
  "chordjack",
  "stream",
  "jumpstream",
  "stamina",
  "tech",
  "ln",
  "sv",
] as const;
type RandomStatus = (typeof RANDOM_STATUS_OPTIONS)[number];
type RandomKey = (typeof RANDOM_KEY_OPTIONS)[number];
type RandomPattern = (typeof RANDOM_PATTERN_OPTIONS)[number];

// Umbrella filters expand to their specific siblings so "Jack" also matches
// chordjack/longjack/etc and "Stream" also matches jumpstream/handstream/etc.
const RANDOM_PATTERN_MATCHES: Record<RandomPattern, string[]> = {
  jack: ["jack", "chordjack", "longjack", "speedjack", "minijack"],
  chordjack: ["chordjack"],
  stream: ["stream", "jumpstream", "chordstream", "handstream", "dumpstream"],
  jumpstream: ["jumpstream"],
  stamina: ["stamina"],
  tech: ["tech"],
  ln: ["ln"],
  sv: ["sv"],
};

const RANDOM_PATTERN_LABEL: Record<RandomPattern, string> = {
  jack: "Jack",
  chordjack: "Chordjack",
  stream: "Stream",
  jumpstream: "Jumpstream",
  stamina: "Stamina",
  tech: "Tech",
  ln: "LN",
  sv: "SV",
};

function parseCsvSet<T extends string>(raw: string, allowed: readonly T[]): Set<T> {
  if (!raw) return new Set();
  const allowedSet = new Set<string>(allowed);
  return new Set(
    raw.split(",").map((s) => s.trim()).filter((s): s is T => allowedSet.has(s)),
  );
}

function toggleCsv(raw: string, value: string): string {
  const parts = raw ? raw.split(",").filter(Boolean) : [];
  const idx = parts.indexOf(value);
  if (idx >= 0) parts.splice(idx, 1);
  else parts.push(value);
  return parts.join(",");
}

// ── Helpers ────────────────────────────────────────────────────────────────

function parseKeyCount(version: string): number | null {
  const match = version.match(/\b(\d)K\b/i);
  return match ? parseInt(match[1]) : null;
}

function matchesKeyFilter(kc: number | null, filter: KeyFilter): boolean {
  if (filter === "all") return true;
  if (filter === "4k") return kc === 4;
  if (filter === "7k") return kc === 7;
  return kc !== null && kc !== 4 && kc !== 7;
}

function matchesStatusFilter(status: string, filter: StatusFilter): boolean {
  if (filter === "all") return true;
  if (filter === "ranked") return status === "ranked" || status === "approved";
  if (filter === "loved") return status === "loved";
  if (filter === "graveyard") return status === "graveyard";
  return status !== "ranked" && status !== "approved" && status !== "loved" && status !== "graveyard";
}

function mapStatusBucket(status: string): RandomStatus {
  if (status === "ranked" || status === "approved") return "ranked";
  if (status === "loved") return "loved";
  if (status === "graveyard") return "graveyard";
  return "other";
}

function mapKeyBucket(keyCount: number): RandomKey {
  if (keyCount === 4) return "4k";
  if (keyCount === 7) return "7k";
  return "other";
}

function matchesSearch(title: string, artist: string, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  return (title ?? "").toLowerCase().includes(q) || (artist ?? "").toLowerCase().includes(q);
}

function hasValidMapsDataShape(data: CountryMapsData | null): data is CountryMapsData {
  if (!data) return false;
  if (!Array.isArray(data.farmed) || !Array.isArray(data.mostPlayed) || !Array.isArray(data.favourites)) {
    return false;
  }
  if (!Array.isArray(data.favouritesByPlayer) || !data.beatmapsetsPool || typeof data.beatmapsetsPool !== "object") {
    return false;
  }

  const sampleSet = Object.values(data.beatmapsetsPool)[0];
  if (
    sampleSet && (
      !Array.isArray(sampleSet.maniaKeys) ||
      typeof sampleSet.previewUrl !== "string" ||
      typeof sampleSet.starMax !== "number" ||
      !Array.isArray(sampleSet.patterns)
    )
  ) {
    return false;
  }

  const sampleFarmed = data.farmed[0];
  if (sampleFarmed) {
    if (
      typeof sampleFarmed.avgPp !== "number" ||
      typeof sampleFarmed.maxPp !== "number" ||
      typeof sampleFarmed.cs !== "number" ||
      !Array.isArray(sampleFarmed.players)
    ) {
      return false;
    }

    const samplePlayer = sampleFarmed.players[0];
    if (
      samplePlayer && (
        typeof samplePlayer.pp !== "number" ||
        !Array.isArray(samplePlayer.mods) ||
        (samplePlayer.scoreUrl !== null && typeof samplePlayer.scoreUrl !== "string")
      )
    ) {
      return false;
    }
  }

  return true;
}

// ── Route ──────────────────────────────────────────────────────────────────

export const Route = createFileRoute("/maps")({
  search: {
    middlewares: [stripSearchParams(DEFAULT_MAPS_SEARCH)],
  },
  validateSearch: (search: Record<string, unknown>): MapsSearch => ({
    tab: search.tab === "popular" || search.tab === "favourites" || search.tab === "random" ? search.tab : DEFAULT_MAPS_SEARCH.tab,
    page: Math.max(0, Number(search.page) || DEFAULT_MAPS_SEARCH.page),
    key: search.key === "4k" || search.key === "7k" || search.key === "other" ? search.key : DEFAULT_MAPS_SEARCH.key,
    beatmapSort: search.beatmapSort === "plays" || search.beatmapSort === "stars" || search.beatmapSort === "length" ? search.beatmapSort : DEFAULT_MAPS_SEARCH.beatmapSort,
    farmedSort: search.farmedSort === "avg-pp" || search.farmedSort === "max-pp" || search.farmedSort === "stars" ? search.farmedSort : DEFAULT_MAPS_SEARCH.farmedSort,
    status: search.status === "ranked" || search.status === "loved" || search.status === "graveyard" || search.status === "other" ? search.status : DEFAULT_MAPS_SEARCH.status,
    pp: search.pp === 500 || search.pp === 700 ? search.pp : DEFAULT_MAPS_SEARCH.pp,
    mod: search.mod === "dt" || search.mod === "ht" || search.mod === "nm" ? search.mod : DEFAULT_MAPS_SEARCH.mod,
    q: typeof search.q === "string" ? search.q : DEFAULT_MAPS_SEARCH.q,
    rStatus: typeof search.rStatus === "string" ? search.rStatus : DEFAULT_MAPS_SEARCH.rStatus,
    rKey: typeof search.rKey === "string" ? search.rKey : DEFAULT_MAPS_SEARCH.rKey,
    rPattern: typeof search.rPattern === "string" ? search.rPattern : DEFAULT_MAPS_SEARCH.rPattern,
  }),
  component: MapsPage,
});

function MapsPage() {
  const navigate = useNavigate();
  const mapsSearch = Route.useSearch();
  const selectedCountry = useSelectedCountry();
  const rankings = useAppStore((s) => s.rankingsByCountry[selectedCountry] ?? null);
  const rankingsFetchedAt = useAppStore((s) => s.rankingsFetchedAtByCountry[selectedCountry] ?? null);
  const mapsData = useAppStore((s) => s.mapsDataByCountry[selectedCountry] ?? null);
  const mapsDataFetchedAt = useAppStore((s) => s.mapsDataFetchedAtByCountry[selectedCountry] ?? null);
  const setRankings = useAppStore((s) => s.setRankings);
  const setMapsData = useAppStore((s) => s.setMapsData);
  const hasValidMapsData = hasValidMapsDataShape(mapsData);

  const [loadingPlayers, setLoadingPlayers] = useState(!rankings);
  const [loadingMaps, setLoadingMaps] = useState(!mapsData);
  const [rebuilding, setRebuilding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tab = mapsSearch.tab;
  const page = mapsSearch.page;
  const keyFilter = mapsSearch.key;
  const beatmapSort = mapsSearch.beatmapSort;
  const farmedSort = mapsSearch.farmedSort;
  const statusFilter = mapsSearch.status;
  const ppFilter = mapsSearch.pp;
  const modFilter = mapsSearch.mod;
  const searchQuery = mapsSearch.q;
  const rStatusRaw = mapsSearch.rStatus;
  const rKeyRaw = mapsSearch.rKey;
  const rPatternRaw = mapsSearch.rPattern;
  const randomStatusSet = useMemo(() => parseCsvSet(rStatusRaw, RANDOM_STATUS_OPTIONS), [rStatusRaw]);
  const randomKeySet = useMemo(() => parseCsvSet(rKeyRaw, RANDOM_KEY_OPTIONS), [rKeyRaw]);
  const randomPatternSet = useMemo(() => parseCsvSet(rPatternRaw, RANDOM_PATTERN_OPTIONS), [rPatternRaw]);
  const randomPatternCanonicalSet = useMemo(() => {
    if (randomPatternSet.size === 0) return null;
    const expanded = new Set<string>();
    for (const p of randomPatternSet) {
      for (const canonical of RANDOM_PATTERN_MATCHES[p]) expanded.add(canonical);
    }
    return expanded;
  }, [randomPatternSet]);
  const countryName = getCountryName(selectedCountry);

  useEffect(() => {
    setLoadingPlayers(!rankings);
    setLoadingMaps(!mapsData || !hasValidMapsData);
    setError(null);
  }, [selectedCountry]);

  const updateMapsSearch = (patch: Partial<MapsSearch>) => {
    navigate({
      to: "/maps",
      search: { ...mapsSearch, ...patch },
      replace: true,
    });
  };

  const players =
    rankings?.ranking.slice(0, 30).map((e: RankingsResponse["ranking"][number]) => ({
      id: e.user.id,
      username: e.user.username,
      avatar_url: e.user.avatar_url,
    })) ?? [];
  const playerIdsKey = useMemo(
    () => players.map((player) => player.id).join(","),
    [players],
  );

  // Fetch rankings
  useEffect(() => {
    let cancelled = false;
    if (!isCacheStale(rankingsFetchedAt, CLIENT_CACHE_TTL.rankings) && rankings) {
      setLoadingPlayers(false);
      return () => { cancelled = true; };
    }

    setLoadingPlayers(!rankings);
    getRankings({ data: { type: "performance", page: 1, country: selectedCountry } })
      .then((r) => {
        if (cancelled) return;
        setRankings(selectedCountry, r);
      })
      .catch(() => {
        if (cancelled || rankings) return;
        setError("Couldn't load the player list.");
      })
      .finally(() => {
        if (!cancelled) setLoadingPlayers(false);
      });

    return () => { cancelled = true; };
  }, [rankings, rankingsFetchedAt, selectedCountry, setRankings]);

  // Fetch maps data
  useEffect(() => {
    if (loadingPlayers || error || players.length === 0) return;

    let cancelled = false;
    if (!isCacheStale(mapsDataFetchedAt, CLIENT_CACHE_TTL.mapsData) && hasValidMapsData) {
      setLoadingMaps(false);
      return () => { cancelled = true; };
    }

    setLoadingMaps(!mapsData || !hasValidMapsData);
    getCountryMapsData({ data: { users: players } })
      .then(({ value, isStale }) => {
        if (cancelled) return;
        setMapsData(selectedCountry, value);
        if (isStale) {
          rebuildCountryMapsData({ data: { users: players } })
            .then((result) => {
              if (cancelled) return;
              if (result.value) {
                setMapsData(selectedCountry, result.value);
              }
            })
            .catch(() => {});
        }
      })
      .catch(() => {
        if (cancelled) return;
        if (!mapsData || !hasValidMapsData) setError("Couldn't load maps data. Try again later.");
      })
      .finally(() => {
        if (!cancelled) setLoadingMaps(false);
      });

    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadingPlayers, error, hasValidMapsData, mapsData, mapsDataFetchedAt, playerIdsKey, selectedCountry]);

  // ── Filtered + sorted: farmed (from best scores) ────────────────────────
  const filteredFarmed = useMemo(() => {
    if (!mapsData?.farmed?.length) return [];
    return mapsData.farmed
      .map((entry) => {
        // When pp filter is active, only keep players meeting the threshold
        if (ppFilter > 0) {
          const filtered = entry.players.filter((p) => p.pp >= ppFilter);
          const filteredMaxPp = Math.max(...filtered.map((p) => p.pp), 0);
          if (filtered.length < 2 && filteredMaxPp < FARMED_SINGLE_PLAYER_PP_MIN) return null;
          return {
            ...entry,
            players: filtered,
            playerCount: filtered.length,
            avgPp: filtered.reduce((s, p) => s + p.pp, 0) / filtered.length,
            maxPp: filteredMaxPp,
          };
        }
        return entry;
      })
      .filter(
        (m): m is MapsFarmedEntry =>
          m !== null &&
          matchesKeyFilter(m.cs, keyFilter) &&
          matchesSearch(m.title, m.artist, searchQuery) &&
          (modFilter === "all" || (
            modFilter === "dt" ? getDominantSpeedMod(m.players) === "DT" :
            modFilter === "ht" ? getDominantSpeedMod(m.players) === "HT" :
            getDominantSpeedMod(m.players) === null
          )),
      )
      .sort((a, b) => {
        if (farmedSort === "players") return b.playerCount - a.playerCount || b.avgPp - a.avgPp;
        if (farmedSort === "avg-pp") return b.avgPp - a.avgPp;
        if (farmedSort === "max-pp") return b.maxPp - a.maxPp;
        return b.difficultyRating - a.difficultyRating;
      });
  }, [mapsData, keyFilter, searchQuery, farmedSort, ppFilter, modFilter]);

  // ── Filtered + sorted: most played (from most_played endpoint) ──────────
  const filteredMostPlayed = useMemo(() => {
    if (!mapsData?.mostPlayed?.length) return [];
    return mapsData.mostPlayed
      .filter(
        (m) =>
          matchesKeyFilter(parseKeyCount(m.version), keyFilter) &&
          matchesSearch(m.title, m.artist, searchQuery),
      )
      .sort((a, b) => {
        if (beatmapSort === "plays") return b.totalPlays - a.totalPlays;
        if (beatmapSort === "players") return b.playerCount - a.playerCount || b.totalPlays - a.totalPlays;
        if (beatmapSort === "stars") return b.difficultyRating - a.difficultyRating;
        return b.totalLength - a.totalLength;
      });
  }, [mapsData, keyFilter, searchQuery, beatmapSort]);

  // ── Filtered + sorted: favourites ───────────────────────────────────────
  const filteredFavourites = useMemo(() => {
    if (!mapsData?.favourites?.length) return [];
    return mapsData.favourites
      .filter(
        (f) =>
          matchesStatusFilter(f.status, statusFilter) &&
          matchesSearch(f.title, f.artist, searchQuery),
      )
      .sort(
        (a, b) =>
          b.playerCount - a.playerCount || b.globalFavouriteCount - a.globalFavouriteCount,
      );
  }, [mapsData, statusFilter, searchQuery]);

  const currentList =
    tab === "farmed"
      ? filteredFarmed
      : tab === "popular"
        ? filteredMostPlayed
        : tab === "favourites"
          ? filteredFavourites
          : [];
  const totalPages = tab === "random" ? 0 : Math.ceil(currentList.length / PAGE_SIZE);
  const paginated = tab === "random" ? [] : currentList.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  const tabs: { id: Tab; label: string }[] = [
    { id: "farmed", label: "most farmed" },
    { id: "popular", label: "widely played" },
    { id: "favourites", label: "community favorites" },
    { id: "random", label: "random picks" },
  ];

  const isLoading = loadingPlayers || loadingMaps;

  // ── Random tab: pick a random top-30 player and a single random favourite ──
  const [randomPlayer, setRandomPlayer] = useState<MapsPlayerFavourites | null>(null);
  const [randomBeatmapset, setRandomBeatmapset] = useState<MapsFavouriteBeatmapset | null>(null);
  const lastRandomKeyRef = useRef<string | null>(null);

  const randomPool = useMemo(() => {
    if (!mapsData?.favouritesByPlayer || !mapsData?.beatmapsetsPool) return [];
    const pairs: Array<{ player: MapsPlayerFavourites; beatmapset: MapsFavouriteBeatmapset }> = [];
    for (const player of mapsData.favouritesByPlayer) {
      for (const bid of player.beatmapsetIds) {
        const beatmapset = mapsData.beatmapsetsPool[bid];
        if (!beatmapset) continue;
        if (randomStatusSet.size > 0 && !randomStatusSet.has(mapStatusBucket(beatmapset.status))) continue;
        if (randomKeySet.size > 0) {
          const keys = beatmapset.maniaKeys ?? [];
          if (!keys.some((k) => randomKeySet.has(mapKeyBucket(k)))) continue;
        }
        if (randomPatternCanonicalSet) {
          const patterns = beatmapset.patterns ?? [];
          if (!patterns.some((p) => randomPatternCanonicalSet.has(p))) continue;
        }
        pairs.push({ player, beatmapset });
      }
    }
    return pairs;
  }, [mapsData, randomStatusSet, randomKeySet, randomPatternCanonicalSet]);

  const reshuffleRandom = useCallback(() => {
    if (randomPool.length === 0) {
      setRandomPlayer(null);
      setRandomBeatmapset(null);
      return;
    }
    const pick = randomPool[Math.floor(Math.random() * randomPool.length)];
    setRandomPlayer(pick.player);
    setRandomBeatmapset(pick.beatmapset);
  }, [randomPool]);

  useEffect(() => {
    if (tab !== "random" || !mapsData) return;
    const dataKey = `${selectedCountry}:${mapsData.generatedAt}`;
    const dataChanged = lastRandomKeyRef.current !== dataKey;
    lastRandomKeyRef.current = dataKey;

    if (dataChanged || !randomBeatmapset) {
      reshuffleRandom();
      return;
    }
    // Keep the current pick if it still matches the filters; otherwise reshuffle.
    const statusOk = randomStatusSet.size === 0 || randomStatusSet.has(mapStatusBucket(randomBeatmapset.status));
    const keyOk =
      randomKeySet.size === 0 ||
      (randomBeatmapset.maniaKeys ?? []).some((k) => randomKeySet.has(mapKeyBucket(k)));
    const patternOk =
      !randomPatternCanonicalSet ||
      (randomBeatmapset.patterns ?? []).some((p) => randomPatternCanonicalSet.has(p));
    if (!statusOk || !keyOk || !patternOk) reshuffleRandom();
  }, [tab, selectedCountry, mapsData, reshuffleRandom, randomBeatmapset, randomStatusSet, randomKeySet, randomPatternCanonicalSet]);

  const hasActiveFilters =
    tab === "random"
      ? randomStatusSet.size > 0 || randomKeySet.size > 0 || randomPatternSet.size > 0
      : (
          searchQuery || keyFilter !== "all" || statusFilter !== "all" || ppFilter > 0 || modFilter !== "all" || beatmapSort !== "players" || farmedSort !== "players" || tab !== "farmed"
        );

  const resetFilters = () => {
    navigate({
      to: "/maps",
      search: { ...DEFAULT_MAPS_SEARCH, tab },
      replace: true,
    });
  };

  const handleDevRebuild = async () => {
    if (rebuilding || players.length === 0) return;
    setRebuilding(true);
    try {
      const result = await rebuildCountryMapsData({ data: { users: players } });
      if (result.value) setMapsData(selectedCountry, result.value);
    } catch {
      setError("Rebuild failed.");
    } finally {
      setRebuilding(false);
    }
  };

  const isDevMode = import.meta.env.VITE_DEV_MODE === "1";

  return (
    <div className="flex-1">
      <PageHeader
        iconSrc="/images/icons/rankings.svg"
        title={`${countryName} mania maps`}
        right={
          <div className="flex items-center gap-2">
            {isLoading && !error && (
              <div className="flex items-center gap-1.5">
                <div className="w-3 h-3 border-2 border-osu-pink/40 border-t-osu-pink rounded-full animate-spin" />
                <span className="text-[10px] text-osu-f1">
                  {loadingPlayers ? "Loading players..." : "Loading maps..."}
                </span>
              </div>
            )}
            {!isLoading && !error && mapsData && (
              <span className="text-[10px] text-osu-f1">
                {currentList.length} maps &middot; updated {formatTimeAgo(mapsData.generatedAt)}
              </span>
            )}
            {isDevMode && !isLoading && !error && mapsData && (
              <button
                onClick={handleDevRebuild}
                disabled={rebuilding}
                className="px-2 py-1 rounded-lg bg-osu-red/20 text-[10px] text-osu-red font-semibold hover:bg-osu-red/30 transition-colors cursor-pointer border border-osu-red/30 disabled:opacity-50 disabled:cursor-not-allowed"
                title="Force rebuild maps data (dev only)"
              >
                {rebuilding ? "Rebuilding..." : "Rebuild"}
              </button>
            )}
          </div>
        }
      />

      <PageTabs
        items={tabs}
        value={tab}
        onChange={(t) => {
          updateMapsSearch({ tab: t, page: 0 });
        }}
      />

      {/* ── Filter bar ───────────────────────────────────────────────── */}
      <div className="bg-osu-d5 border-b border-osu-b3/20">
        <div className="max-w-[1200px] mx-auto px-4 sm:px-5 py-2.5 flex flex-wrap items-center gap-x-4 gap-y-2">
          {tab !== "random" && (
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => updateMapsSearch({ q: e.target.value, page: 0 })}
            placeholder="Search title or artist..."
            className="bg-osu-b4 border border-osu-b3/30 rounded-lg px-3 py-1.5 text-[11px] text-osu-l2 placeholder:text-osu-f1 w-full sm:w-48 focus:outline-none focus:border-osu-pink/40 transition-colors"
          />
          )}

          {tab === "random" && (
            <>
              <FilterGroup label="Status">
                {RANDOM_STATUS_OPTIONS.map((s) => (
                  <FilterPill
                    key={s}
                    active={randomStatusSet.has(s)}
                    dimmed={randomStatusSet.size === 0}
                    onClick={() => updateMapsSearch({ rStatus: toggleCsv(rStatusRaw, s) })}
                  >
                    {s.charAt(0).toUpperCase() + s.slice(1)}
                  </FilterPill>
                ))}
              </FilterGroup>

              <FilterGroup label="Keys">
                {RANDOM_KEY_OPTIONS.map((k) => (
                  <FilterPill
                    key={k}
                    active={randomKeySet.has(k)}
                    dimmed={randomKeySet.size === 0}
                    onClick={() => updateMapsSearch({ rKey: toggleCsv(rKeyRaw, k) })}
                  >
                    {k.toUpperCase()}
                  </FilterPill>
                ))}
              </FilterGroup>

              <FilterGroup label="Type">
                {RANDOM_PATTERN_OPTIONS.map((p) => (
                  <FilterPill
                    key={p}
                    active={randomPatternSet.has(p)}
                    dimmed={randomPatternSet.size === 0}
                    onClick={() => updateMapsSearch({ rPattern: toggleCsv(rPatternRaw, p) })}
                  >
                    {RANDOM_PATTERN_LABEL[p]}
                  </FilterPill>
                ))}
              </FilterGroup>

              <span className="text-[10px] text-osu-f1">
                {randomPool.length} {randomPool.length === 1 ? "match" : "matches"}
              </span>
            </>
          )}

          {tab === "farmed" && (
            <>
              {/* Key count */}
              <FilterGroup label="Keys">
                {(["all", "4k", "7k", "other"] as KeyFilter[]).map((k) => (
                  <FilterPill key={k} active={keyFilter === k} onClick={() => updateMapsSearch({ key: k, page: 0 })}>
                    {k === "all" ? "All" : k.toUpperCase()}
                  </FilterPill>
                ))}
              </FilterGroup>

              {/* Mod type */}
              <FilterGroup label="Mods">
                {(["all", "dt", "ht", "nm"] as ModFilter[]).map((m) => (
                  <FilterPill key={m} active={modFilter === m} onClick={() => updateMapsSearch({ mod: m, page: 0 })}>
                    {m === "all" ? "All" : m === "nm" ? "NM" : m.toUpperCase()}
                  </FilterPill>
                ))}
              </FilterGroup>

              {/* Min PP */}
              <FilterGroup label="Min PP">
                {([0, 500, 700] as PpFilter[]).map((pp) => (
                  <FilterPill key={pp} active={ppFilter === pp} onClick={() => updateMapsSearch({ pp, page: 0 })}>
                    {pp === 0 ? "All" : `${pp}+`}
                  </FilterPill>
                ))}
              </FilterGroup>

              {/* Sort */}
              <FilterGroup label="Sort">
                {([
                  ["players", "Players"],
                  ["avg-pp", "Avg PP"],
                  ["max-pp", "Max PP"],
                  ["stars", "Stars"],
                ] as [FarmedSort, string][]).map(([id, label]) => (
                  <FilterPill key={id} active={farmedSort === id} onClick={() => updateMapsSearch({ farmedSort: id, page: 0 })}>
                    {label}
                  </FilterPill>
                ))}
              </FilterGroup>
            </>
          )}

          {tab === "popular" && (
            <>
              <FilterGroup label="Keys">
                {(["all", "4k", "7k", "other"] as KeyFilter[]).map((k) => (
                  <FilterPill key={k} active={keyFilter === k} onClick={() => updateMapsSearch({ key: k, page: 0 })}>
                    {k === "all" ? "All" : k.toUpperCase()}
                  </FilterPill>
                ))}
              </FilterGroup>

              <FilterGroup label="Sort">
                {([
                  ["players", "Players"],
                  ["plays", "Plays"],
                  ["stars", "Stars"],
                  ["length", "Length"],
                ] as [BeatmapSort, string][]).map(([id, label]) => (
                  <FilterPill key={id} active={beatmapSort === id} onClick={() => updateMapsSearch({ beatmapSort: id, page: 0 })}>
                    {label}
                  </FilterPill>
                ))}
              </FilterGroup>
            </>
          )}

          {tab === "favourites" && (
            <FilterGroup label="Status">
              {(["all", "ranked", "loved", "graveyard", "other"] as StatusFilter[]).map((s) => (
                <FilterPill key={s} active={statusFilter === s} onClick={() => updateMapsSearch({ status: s, page: 0 })}>
                  {s === "all" ? "All" : s.charAt(0).toUpperCase() + s.slice(1)}
                </FilterPill>
              ))}
            </FilterGroup>
          )}

          {hasActiveFilters && (
            <button
              onClick={resetFilters}
              className="text-[10px] text-osu-pink-light hover:text-white transition-colors cursor-pointer"
            >
              Clear filters
            </button>
          )}
        </div>
      </div>

      {/* ── Content ──────────────────────────────────────────────────── */}
      <div className="bg-osu-b5">
        <div className="max-w-[1200px] mx-auto px-5 py-6">
          {error && (
            <div className="text-center py-16 text-osu-f1 text-sm">{error}</div>
          )}

          {/* Loading skeleton grid */}
          {!error && isLoading && (!mapsData || !hasValidMapsData) && (
            <div className="space-y-3">
              <MapsLoadingIndicator loadingPlayers={loadingPlayers} />
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
                {Array.from({ length: 12 }).map((_, i) => (
                  <div key={i} className="rounded-xl bg-osu-b4 border border-osu-b3/20 overflow-hidden">
                    <Skeleton className="w-full h-[90px] rounded-none" />
                    <div className="p-3 space-y-2">
                      <Skeleton className="h-3.5 w-3/4" />
                      <Skeleton className="h-3 w-1/2" />
                      <Skeleton className="h-3 w-2/3" />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Card grid */}
          {tab !== "random" && !error && paginated.length > 0 && (
            <div key={`${tab}-${page}`} className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3 cards-enter">
                {tab === "farmed"
                  ? (paginated as MapsFarmedEntry[]).map((map) => (
                      <FarmedCard
                        key={map.beatmapId}
                        map={map}
                        onPlayerClick={(u) => navigate({ to: "/player/$username", params: { username: u } })}
                      />
                    ))
                  : tab === "popular"
                    ? (paginated as MapsAggregatedBeatmap[]).map((map) => (
                        <MostPlayedCard
                          key={map.beatmapId}
                          map={map}
                          onPlayerClick={(u) => navigate({ to: "/player/$username", params: { username: u } })}
                        />
                      ))
                    : (paginated as MapsAggregatedFavourite[]).map((fav) => (
                        <FavouriteCard
                          key={fav.beatmapsetId}
                          fav={fav}
                          onPlayerClick={(u) => navigate({ to: "/player/$username", params: { username: u } })}
                        />
                      ))}
            </div>
          )}

          {tab !== "random" && !error && !isLoading && currentList.length === 0 && (
            <div className="text-center py-16 text-osu-f1 text-sm">
              No maps match your filters
            </div>
          )}

          {/* Random tab */}
          {tab === "random" && !error && !isLoading && mapsData && (
            <div className="max-w-[640px] mx-auto space-y-5">
              {randomPlayer && randomBeatmapset ? (
                <>
                  <div className="flex items-center justify-between flex-wrap gap-3">
                    <button
                      onClick={() => navigate({ to: "/player/$username", params: { username: randomPlayer.username } })}
                      className="flex items-center gap-3 group cursor-pointer"
                    >
                      <Avatar url={randomPlayer.avatarUrl} size={44} />
                      <div className="text-left">
                        <div className="text-[10px] uppercase tracking-wider text-osu-f1">
                          random pick from
                        </div>
                        <div className="text-[15px] font-semibold text-osu-l2 group-hover:text-white transition-colors">
                          {randomPlayer.username}
                        </div>
                        <div className="text-[10px] text-osu-f1">
                          {randomPlayer.beatmapsetIds.length} favourites
                        </div>
                      </div>
                    </button>
                    <button
                      onClick={reshuffleRandom}
                      className="px-3 py-1.5 rounded-lg bg-osu-pink/20 text-[11px] text-osu-pink-light font-semibold hover:bg-osu-pink/30 transition-colors cursor-pointer border border-osu-pink/30"
                    >
                      Reroll
                    </button>
                  </div>
                  <div key={`random-${randomPlayer.id}-${randomBeatmapset.id}`} className="cards-enter">
                    <RandomCard bm={randomBeatmapset} />
                  </div>
                </>
              ) : (
                <div className="text-center py-16 text-osu-f1 text-sm">
                  {hasActiveFilters
                    ? "No favourites match your filters. Try loosening them."
                    : "No favourites found for any player in the top 30."}
                </div>
              )}
            </div>
          )}

          {/* Pagination */}
          {tab !== "random" && (
            <Pagination page={page} totalPages={totalPages} onPageChange={(p) => updateMapsSearch({ page: p })} />
          )}
        </div>
      </div>
    </div>
  );
}

// ── Loading indicator ─────────────────────────────────────────────────────

const LOADING_STEPS = [
  "Loading maps...",
  "Almost there...",
];

function MapsLoadingIndicator({ loadingPlayers }: { loadingPlayers: boolean }) {
  const [stepIndex, setStepIndex] = useState(0);

  useEffect(() => {
    if (loadingPlayers) return;
    const id = setInterval(() => {
      setStepIndex((i) => (i + 1) % LOADING_STEPS.length);
    }, 3000);
    return () => clearInterval(id);
  }, [loadingPlayers]);

  const label = loadingPlayers ? "Loading players..." : LOADING_STEPS[stepIndex];

  return (
    <div className="flex items-center gap-3">
      <div className="flex-1 h-1 rounded-full bg-osu-b3/40 overflow-hidden">
        <div className="h-full w-1/3 rounded-full bg-osu-pink animate-[indeterminate_1.5s_ease-in-out_infinite]" />
      </div>
      <span className="text-[11px] text-osu-f1 flex-shrink-0">{label}</span>
    </div>
  );
}

// ── Filter UI ──────────────────────────────────────────────────────────────

function FilterGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[9px] uppercase tracking-wider text-osu-f1 font-semibold">{label}</span>
      <div className="flex gap-0.5">{children}</div>
    </div>
  );
}

function FilterPill({ active, onClick, children, dimmed }: { active: boolean; onClick: () => void; children: React.ReactNode; dimmed?: boolean }) {
  return (
    <button
      onClick={onClick}
      className={`px-2 py-1 rounded text-[10px] font-medium transition-colors cursor-pointer ${
        active
          ? "bg-osu-pink/20 text-osu-pink-light"
          : dimmed
            ? "bg-osu-b4/60 text-osu-f1/70 hover:text-osu-l2 hover:bg-osu-b3"
            : "bg-osu-b4 text-osu-f1 hover:text-osu-l2 hover:bg-osu-b3"
      }`}
    >
      {children}
    </button>
  );
}

// ── Dominant speed mod for farmed cards ───────────────────────────────────

/**
 * Determines the dominant speed mod (DT or HT) for a farmed map.
 * - DT and NC are treated as the same (returns "DT").
 * - HT is only returned if the highest PP play also has HT.
 * - Only DT/NC/HT are considered, no other mods.
 */
function getDominantSpeedMod(players: MapsFarmedPlayer[]): "DT" | "HT" | null {
  let dtCount = 0;
  let htCount = 0;
  for (const p of players) {
    const mods = p.mods ?? [];
    if (mods.includes("DT") || mods.includes("NC")) dtCount++;
    else if (mods.includes("HT")) htCount++;
  }

  if (dtCount === 0 && htCount === 0) return null;

  if (dtCount >= htCount) {
    // Majority is DT/NC — need at least half the players
    if (dtCount > players.length / 2) return "DT";
    return null;
  }

  // Majority is HT — check that the top PP play is also HT
  if (htCount > players.length / 2) {
    const topPlayer = players.reduce((best, p) => (p.pp > best.pp ? p : best), players[0]);
    if ((topPlayer.mods ?? []).includes("HT")) return "HT";
  }
  return null;
}

// ── Mod helpers ───────────────────────────────────────────────────────────

const MAIN_MODS = new Set(["DT", "NC", "HR", "HT", "DC", "EZ", "FL", "HD", "FI"]);

function getMainMod(mods?: string[]): string | null {
  if (!mods) return null;
  return mods.find((m) => MAIN_MODS.has(m)) ?? null;
}

const miniModColors: Record<string, string> = {
  DT: "#ff6666", NC: "#ff6666", HR: "#ff6666", FL: "#ff6666", HD: "#ff6666", FI: "#ff6666",
  HT: "#b3d944", DC: "#b3d944", EZ: "#b3d944",
};

const miniModFileMap: Record<string, string> = {
  DT: "double-time", NC: "nightcore", HR: "hard-rock", HT: "half-time",
  DC: "daycore", EZ: "easy", FL: "flashlight", HD: "hidden", FI: "fade-in",
};

function MiniModIcon({ mod, size = 10 }: { mod: string; size?: number }) {
  const bg = miniModColors[mod] || "#ff6666";
  const file = miniModFileMap[mod];
  if (!file) return null;
  const offset = Math.round(size * -0.3);
  return (
    <span
      className="absolute rounded-full border border-osu-b5 z-10 overflow-hidden"
      style={{ width: size, height: size, top: offset, right: offset, backgroundColor: bg }}
      title={mod}
    >
      <span
        className="absolute inset-0"
        style={{
          backgroundColor: `color-mix(in srgb-linear, black, ${bg} 10%)`,
          maskImage: `url(/images/badges/mods/mod-${file}.svg)`,
          WebkitMaskImage: `url(/images/badges/mods/mod-${file}.svg)`,
          maskSize: "110%", WebkitMaskSize: "110%",
          maskPosition: "center", WebkitMaskPosition: "center",
          maskRepeat: "no-repeat", WebkitMaskRepeat: "no-repeat",
        }}
      />
    </span>
  );
}

// ── Player overflow popover ────────────────────────────────────────────────

function PlayerAvatars({
  players,
  onPlayerClick,
  renderMeta,
}: {
  players: Array<{ id: number; username: string; avatarUrl: string; pp?: number; count?: number; mods?: string[]; scoreUrl?: string | null }>;
  onPlayerClick: (player: { id: number; username: string; avatarUrl: string; pp?: number; count?: number; mods?: string[]; scoreUrl?: string | null }) => void;
  renderMeta?: (p: { pp?: number; count?: number; mods?: string[] }) => React.ReactNode;
}) {
  const [showPopover, setShowPopover] = useState(false);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const visible = players.slice(0, VISIBLE_AVATARS);
  const overflow = players.length - VISIBLE_AVATARS;

  const openPopover = () => {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    setShowPopover(true);
  };

  const closePopoverSoon = () => {
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    closeTimerRef.current = setTimeout(() => {
      setShowPopover(false);
      closeTimerRef.current = null;
    }, 120);
  };

  useEffect(() => {
    return () => {
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    };
  }, []);

  return (
    <div className="flex items-center gap-0.5 mt-1.5">
      {visible.map((p) => {
        const mainMod = getMainMod(p.mods);
        return (
          <button
            key={p.id}
            onClick={() => onPlayerClick(p)}
            className="cursor-pointer relative"
            title={p.pp ? `${Math.round(p.pp)}pp` : p.username}
          >
            <Avatar url={p.avatarUrl} size={18} />
            {mainMod && <MiniModIcon mod={mainMod} />}
          </button>
        );
      })}
      {overflow > 0 && (
        <div
          className="relative"
          onMouseEnter={openPopover}
          onMouseLeave={closePopoverSoon}
        >
          <span className="text-[8px] text-osu-f1 ml-0.5 cursor-default hover:text-osu-l2 transition-colors">
            +{overflow}
          </span>
          {showPopover && (
            <div
              className="absolute bottom-full left-0 mb-1.5 p-1.5 rounded-lg bg-osu-b3 border border-osu-b3/60 shadow-xl z-50 min-w-[160px] max-h-[220px] overflow-y-auto"
              onMouseEnter={openPopover}
              onMouseLeave={closePopoverSoon}
            >
              {players.slice(VISIBLE_AVATARS).map((p) => (
                <button
                  key={p.id}
                  onClick={() => onPlayerClick(p)}
                  className="flex items-center gap-2 w-full py-1 px-1.5 rounded hover:bg-osu-b4 cursor-pointer transition-colors text-left"
                >
                  <Avatar url={p.avatarUrl} size={16} />
                  <div className="min-w-0 flex-1 text-[10px] text-osu-l2 truncate">{p.username}</div>
                  {renderMeta?.(p)}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Farmed card (from best scores) ─────────────────────────────────────────

function FarmedCard({ map, onPlayerClick }: { map: MapsFarmedEntry; onPlayerClick: (u: string) => void }) {
  const url = `https://osu.ppy.sh/beatmapsets/${map.beatmapsetId}#mania/${map.beatmapId}`;
  const dominantMod = getDominantSpeedMod(map.players);
  const dominantModFile = dominantMod === "DT" ? "double-time" : dominantMod === "HT" ? "half-time" : null;
  const dominantModColor = dominantMod === "DT" ? "#ff6666" : "#b3d944";

  return (
    <div className="rounded-xl bg-osu-b4 border border-osu-b3/20 hover:border-osu-pink/30 transition-colors">
      <a href={url} target="_blank" rel="noreferrer" className="block relative rounded-t-xl overflow-hidden">
        <img src={map.covers.card} alt="" className="w-full h-[90px] object-cover" loading="lazy" />
        <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-transparent" />
        {dominantModFile && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none -translate-y-2.5">
            <div className="relative w-[56px] h-[38px] opacity-70">
              {/* Base badge shape */}
              <img src="/images/badges/mods/mod-icon.svg" alt="" className="absolute inset-0 w-full h-full" style={{ filter: `brightness(0) saturate(100%)` }} />
              <div
                className="absolute inset-0"
                style={{
                  backgroundColor: dominantModColor,
                  maskImage: "url(/images/badges/mods/mod-icon.svg)",
                  WebkitMaskImage: "url(/images/badges/mods/mod-icon.svg)",
                  maskSize: "100%", WebkitMaskSize: "100%",
                  maskRepeat: "no-repeat", WebkitMaskRepeat: "no-repeat",
                }}
              />
              {/* Mod icon overlay */}
              <div
                className="absolute inset-0"
                style={{
                  backgroundColor: `color-mix(in srgb-linear, black, ${dominantModColor} 10%)`,
                  maskImage: `url(/images/badges/mods/mod-${dominantModFile}.svg)`,
                  WebkitMaskImage: `url(/images/badges/mods/mod-${dominantModFile}.svg)`,
                  maskSize: "110%", WebkitMaskSize: "110%",
                  maskPosition: "center", WebkitMaskPosition: "center",
                  maskRepeat: "no-repeat", WebkitMaskRepeat: "no-repeat",
                }}
              />
            </div>
          </div>
        )}
        <span className="absolute top-1.5 left-1.5 px-1.5 py-0.5 rounded bg-black/60 text-[9px] font-bold text-white">
          {map.cs}K
        </span>
        <span className="absolute top-1.5 right-1.5 px-1.5 py-0.5 rounded bg-black/60 text-[9px] font-bold text-osu-yellow">
          {"\u2605"}{map.difficultyRating.toFixed(2)}
        </span>
        <div className="absolute bottom-0 left-0 right-0 px-2.5 pb-1.5">
          <div className="text-[12px] font-semibold text-white truncate leading-tight drop-shadow-lg">{map.title}</div>
          <div className="text-[10px] text-white/70 truncate leading-tight drop-shadow-lg">{map.artist}</div>
        </div>
      </a>

      <div className="px-2.5 py-2">
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] text-osu-l2 truncate flex-1">[{map.version}]</span>
          <span className="text-[9px] text-osu-f1 flex-shrink-0">{formatDuration(Math.round(dominantMod === "DT" ? map.totalLength / 1.5 : dominantMod === "HT" ? map.totalLength / 0.75 : map.totalLength))}</span>
        </div>

        <div className="flex items-center gap-3 mt-1.5">
          <div className="flex items-center gap-1">
            <span className="text-[11px] font-bold text-osu-blue" style={{ fontFamily: "Torus" }}>{map.playerCount}</span>
            <span className="text-[8px] text-osu-f1 uppercase">{map.playerCount === 1 ? "player" : "players"}</span>
          </div>
          <div className="flex items-center gap-1">
            <span className="text-[11px] font-bold text-osu-pink" style={{ fontFamily: "Torus" }}>~{Math.round(map.avgPp)}</span>
            <span className="text-[8px] text-osu-f1 uppercase">avg pp</span>
          </div>
        </div>

        <PlayerAvatars
          players={map.players}
          onPlayerClick={(player) => {
            if (player.scoreUrl) {
              window.open(player.scoreUrl, "_blank", "noopener,noreferrer");
              return;
            }
            onPlayerClick(player.username);
          }}
          renderMeta={(p) => (
            <div className="ml-auto flex items-center gap-1 flex-shrink-0">
              {p.mods?.map((mod) => (
                <span key={mod} className="inline-flex origin-center scale-[0.34] -mx-2">
                  <ModBadge mod={mod} />
                </span>
              ))}
              {(p as MapsFarmedPlayer).pp ? (
                <span className="text-[9px] text-osu-pink whitespace-nowrap">
                  {Math.round((p as MapsFarmedPlayer).pp)}pp
                </span>
              ) : null}
            </div>
          )}
        />
      </div>
    </div>
  );
}

// ── Most Played card (from most_played endpoint) ───────────────────────────

function MostPlayedCard({ map, onPlayerClick }: { map: MapsAggregatedBeatmap; onPlayerClick: (u: string) => void }) {
  const kc = parseKeyCount(map.version);
  const url = `https://osu.ppy.sh/beatmapsets/${map.beatmapsetId}#mania/${map.beatmapId}`;

  return (
    <div className="rounded-xl bg-osu-b4 border border-osu-b3/20 hover:border-osu-pink/30 transition-colors">
      <a href={url} target="_blank" rel="noreferrer" className="block relative rounded-t-xl overflow-hidden">
        <img src={map.covers.card} alt="" className="w-full h-[90px] object-cover" loading="lazy" />
        <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-transparent" />
        {kc && (
          <span className="absolute top-1.5 left-1.5 px-1.5 py-0.5 rounded bg-black/60 text-[9px] font-bold text-white">{kc}K</span>
        )}
        <span className="absolute top-1.5 right-1.5 px-1.5 py-0.5 rounded bg-black/60 text-[9px] font-bold text-osu-yellow">
          {"\u2605"}{map.difficultyRating.toFixed(2)}
        </span>
        <div className="absolute bottom-0 left-0 right-0 px-2.5 pb-1.5">
          <div className="text-[12px] font-semibold text-white truncate leading-tight drop-shadow-lg">{map.title}</div>
          <div className="text-[10px] text-white/70 truncate leading-tight drop-shadow-lg">{map.artist}</div>
        </div>
      </a>

      <div className="px-2.5 py-2">
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] text-osu-l2 truncate flex-1">[{map.version}]</span>
          <span className="text-[9px] text-osu-f1 flex-shrink-0">{formatDuration(map.totalLength)}</span>
        </div>

        <div className="flex items-center gap-3 mt-1.5">
          <div className="flex items-center gap-1">
            <span className="text-[11px] font-bold text-osu-pink" style={{ fontFamily: "Torus" }}>{formatNumber(map.totalPlays)}</span>
            <span className="text-[8px] text-osu-f1 uppercase">plays</span>
          </div>
          <div className="flex items-center gap-1">
            <span className="text-[11px] font-bold text-osu-blue" style={{ fontFamily: "Torus" }}>{map.playerCount}</span>
            <span className="text-[8px] text-osu-f1 uppercase">{map.playerCount === 1 ? "player" : "players"}</span>
          </div>
        </div>

        <PlayerAvatars
          players={map.players}
          onPlayerClick={(player) => onPlayerClick(player.username)}
          renderMeta={(p) => (p as MapsPlayerEntry).count ? (
            <span className="text-[9px] text-osu-pink whitespace-nowrap">
              {formatNumber((p as MapsPlayerEntry).count)}x
            </span>
          ) : null}
        />
      </div>
    </div>
  );
}

// ── Favourite card ─────────────────────────────────────────────────────────

function FavouriteCard({ fav, onPlayerClick }: { fav: MapsAggregatedFavourite; onPlayerClick: (u: string) => void }) {
  const selectedCountry = useSelectedCountry();
  const url = `https://osu.ppy.sh/beatmapsets/${fav.beatmapsetId}`;

  return (
    <div className="rounded-xl bg-osu-b4 border border-osu-b3/20 hover:border-osu-pink/30 transition-colors">
      <a href={url} target="_blank" rel="noreferrer" className="block relative rounded-t-xl overflow-hidden">
        <img src={fav.covers.card} alt="" className="w-full h-[90px] object-cover" loading="lazy" />
        <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-transparent" />
        <span
          className={`absolute top-1.5 left-1.5 px-1.5 py-0.5 rounded text-[9px] font-bold uppercase ${
            fav.status === "ranked"
              ? "bg-osu-green/80 text-white"
              : fav.status === "loved"
                ? "bg-osu-pink/80 text-white"
                : "bg-black/60 text-white/80"
          }`}
        >
          {fav.status}
        </span>
        <div className="absolute bottom-0 left-0 right-0 px-2.5 pb-1.5">
          <div className="text-[12px] font-semibold text-white truncate leading-tight drop-shadow-lg">{fav.title}</div>
          <div className="text-[10px] text-white/70 truncate leading-tight drop-shadow-lg">{fav.artist}</div>
        </div>
      </a>

      <div className="px-2.5 py-2">
        <div className="text-[10px] text-osu-f1 truncate">mapped by {fav.creator}</div>

        <div className="flex items-center gap-3 mt-1.5">
          <div className="flex items-center gap-1">
            <span className="text-[11px] font-bold text-osu-pink" style={{ fontFamily: "Torus" }}>{fav.playerCount}</span>
            <span className="text-[8px] text-osu-f1 uppercase">{selectedCountry} favs</span>
          </div>
          <div className="flex items-center gap-1">
            <span className="text-[11px] font-bold text-osu-l2" style={{ fontFamily: "Torus" }}>{formatNumber(fav.globalFavouriteCount)}</span>
            <span className="text-[8px] text-osu-f1 uppercase">global</span>
          </div>
        </div>

        <PlayerAvatars players={fav.players} onPlayerClick={(player) => onPlayerClick(player.username)} />
      </div>
    </div>
  );
}

// ── Random card (hero-sized favourite card for the Random tab) ────────────

const PREVIEW_VOLUME_STORAGE_KEY = "mania-hub-preview-volume-v1";
const DEFAULT_PREVIEW_VOLUME = 0.3;

function readStoredPreviewVolume(): number {
  if (typeof window === "undefined") return DEFAULT_PREVIEW_VOLUME;
  try {
    const raw = window.localStorage.getItem(PREVIEW_VOLUME_STORAGE_KEY);
    if (raw == null) return DEFAULT_PREVIEW_VOLUME;
    const parsed = Number.parseFloat(raw);
    if (!Number.isFinite(parsed)) return DEFAULT_PREVIEW_VOLUME;
    return Math.min(1, Math.max(0, parsed));
  } catch {
    return DEFAULT_PREVIEW_VOLUME;
  }
}

function formatStars(bm: MapsFavouriteBeatmapset): string | null {
  const min = typeof bm.starMin === "number" ? bm.starMin : 0;
  const max = typeof bm.starMax === "number" ? bm.starMax : 0;
  if (!max) return null;
  const fmt = (v: number) => (v >= 10 ? v.toFixed(1) : v.toFixed(2));
  if (!min || Math.abs(max - min) < 0.05) return fmt(max);
  return `${fmt(min)}–${fmt(max)}`;
}

function RandomCard({ bm }: { bm: MapsFavouriteBeatmapset }) {
  const url = `https://osu.ppy.sh/beatmapsets/${bm.id}`;
  const keys = bm.maniaKeys ?? [];
  const patterns = (bm.patterns ?? []).slice(0, 5);
  const starLabel = formatStars(bm);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [isPreviewPlaying, setIsPreviewPlaying] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState<number>(readStoredPreviewVolume);
  const lastNonZeroVolumeRef = useRef<number>(volume > 0 ? volume : DEFAULT_PREVIEW_VOLUME);
  const rawPreviewUrl = typeof bm.previewUrl === "string" ? bm.previewUrl : "";
  const previewUrl = rawPreviewUrl.startsWith("//") ? `https:${rawPreviewUrl}` : rawPreviewUrl;

  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = volume;
  }, [volume]);

  useEffect(() => {
    if (!isPreviewPlaying) return;
    let rafId = 0;
    const tick = () => {
      const audio = audioRef.current;
      if (audio) setCurrentTime(audio.currentTime);
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [isPreviewPlaying]);

  const stopPreview = useCallback(() => {
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      audio.currentTime = 0;
    }
    setIsPreviewPlaying(false);
    setCurrentTime(0);
  }, []);

  const togglePreview = useCallback(async () => {
    if (!previewUrl) return;
    const audio = audioRef.current;
    if (!audio) return;

    if (isPreviewPlaying) {
      audio.pause();
      return;
    }

    setPreviewError(null);
    try {
      await audio.play();
    } catch {
      setPreviewError("Couldn't play preview");
      setIsPreviewPlaying(false);
    }
  }, [isPreviewPlaying, previewUrl]);

  const applyVolume = useCallback((v: number) => {
    const clamped = Math.min(1, Math.max(0, v));
    setVolume(clamped);
    if (clamped > 0) lastNonZeroVolumeRef.current = clamped;
    try {
      window.localStorage.setItem(PREVIEW_VOLUME_STORAGE_KEY, String(clamped));
    } catch {
      /* ignore quota errors */
    }
  }, []);

  const toggleMute = useCallback(() => {
    if (volume > 0) {
      applyVolume(0);
    } else {
      applyVolume(lastNonZeroVolumeRef.current || DEFAULT_PREVIEW_VOLUME);
    }
  }, [applyVolume, volume]);

  const progressRatio = duration > 0 ? Math.min(1, currentTime / duration) : 0;

  return (
    <div className="rounded-2xl bg-osu-b4 border border-osu-b3/20 hover:border-osu-pink/40 transition-colors overflow-hidden">
      <a href={url} target="_blank" rel="noreferrer" className="block relative">
        <img src={bm.covers.cover} alt="" className="w-full h-[220px] object-cover" loading="lazy" />
        <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/20 to-transparent" />
        <span
          className={`absolute top-3 left-3 px-2 py-1 rounded text-[10px] font-bold uppercase ${
            bm.status === "ranked" || bm.status === "approved"
              ? "bg-osu-green/80 text-white"
              : bm.status === "loved"
                ? "bg-osu-pink/80 text-white"
                : "bg-black/60 text-white/80"
          }`}
        >
          {bm.status}
        </span>
        <div className="absolute top-3 right-3 flex items-center gap-1">
          {keys.map((k) => (
            <span key={k} className="px-1.5 py-0.5 rounded bg-black/60 text-[10px] font-bold text-white">
              {k}K
            </span>
          ))}
          {starLabel && (
            <span className="px-1.5 py-0.5 rounded bg-black/60 text-[10px] font-bold text-osu-yellow">
              {"\u2605"}{starLabel}
            </span>
          )}
        </div>
        <div className="absolute bottom-0 left-0 right-0 px-4 pb-3">
          <div className="text-[18px] font-semibold text-white truncate leading-tight drop-shadow-lg">{bm.title}</div>
          <div className="text-[13px] text-white/75 truncate leading-tight drop-shadow-lg">{bm.artist}</div>
        </div>
      </a>

      <div className="px-4 py-3 space-y-3">
        <div className="flex items-end justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[11px] text-osu-f1 truncate">mapped by {bm.creator}</div>
            {bm.bpm > 0 && (
              <div className="text-[10px] text-osu-f1/80 truncate">{Math.round(bm.bpm)} BPM</div>
            )}
          </div>
          <div className="flex items-center gap-4 flex-shrink-0">
            <div className="flex items-center gap-1">
              <span className="text-[13px] font-bold text-osu-l2" style={{ fontFamily: "Torus" }}>{formatNumber(bm.globalFavouriteCount)}</span>
              <span className="text-[9px] text-osu-f1 uppercase">favs</span>
            </div>
            <div className="flex items-center gap-1">
              <span className="text-[13px] font-bold text-osu-l2" style={{ fontFamily: "Torus" }}>{formatNumber(bm.globalPlayCount)}</span>
              <span className="text-[9px] text-osu-f1 uppercase">plays</span>
            </div>
          </div>
        </div>

        {patterns.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            {patterns.map((p) => (
              <span
                key={p}
                className="px-2 py-0.5 rounded-full bg-osu-pink/15 border border-osu-pink/25 text-[10px] font-semibold text-osu-pink-light tracking-wide"
              >
                {MANIA_PATTERN_LABELS[p] ?? p}
              </span>
            ))}
          </div>
        )}

        {previewUrl ? (
          <div className="flex items-center gap-2">
            <button
              onClick={togglePreview}
              aria-label={isPreviewPlaying ? "Pause preview" : "Play preview"}
              className="w-8 h-8 rounded-full bg-osu-pink/90 hover:bg-osu-pink transition-colors flex items-center justify-center cursor-pointer shrink-0 shadow-sm shadow-osu-pink/30"
            >
              {isPreviewPlaying ? (
                <svg viewBox="0 0 24 24" fill="white" className="w-[14px] h-[14px]">
                  <rect x="6.5" y="5" width="4" height="14" rx="1.4" />
                  <rect x="13.5" y="5" width="4" height="14" rx="1.4" />
                </svg>
              ) : (
                <svg
                  viewBox="0 0 24 24"
                  fill="white"
                  stroke="white"
                  strokeWidth="2"
                  strokeLinejoin="round"
                  strokeLinecap="round"
                  className="w-[14px] h-[14px]"
                >
                  <path d="M8 5L20 12L8 19Z" />
                </svg>
              )}
            </button>

            <div
              onClick={(e) => {
                const audio = audioRef.current;
                if (!audio || !duration) return;
                const rect = e.currentTarget.getBoundingClientRect();
                const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
                audio.currentTime = ratio * duration;
                setCurrentTime(audio.currentTime);
              }}
              className="flex-1 h-1 bg-osu-b3/60 rounded-full cursor-pointer relative group"
            >
              <div
                className="absolute inset-y-0 left-0 bg-osu-pink rounded-full"
                style={{ width: `${progressRatio * 100}%` }}
              />
            </div>

            <span className="text-[9px] text-osu-f1 tabular-nums shrink-0">
              {formatDuration(Math.floor(currentTime))}/{duration > 0 ? formatDuration(Math.floor(duration)) : "--:--"}
            </span>

            <button
              onClick={toggleMute}
              aria-label={volume === 0 ? "Unmute preview" : "Mute preview"}
              className="w-5 h-5 flex items-center justify-center cursor-pointer shrink-0 text-osu-f1 hover:text-white transition-colors"
            >
              {volume === 0 ? (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5">
                  <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor" />
                  <line x1="23" y1="9" x2="17" y2="15" />
                  <line x1="17" y1="9" x2="23" y2="15" />
                </svg>
              ) : volume < 0.5 ? (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5">
                  <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor" />
                  <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5">
                  <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor" />
                  <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                  <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
                </svg>
              )}
            </button>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={volume}
              onChange={(e) => applyVolume(Number(e.target.value))}
              aria-label="Preview volume"
              className="w-12 h-1 appearance-none bg-osu-b3 rounded-full cursor-pointer shrink-0 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-2 [&::-webkit-slider-thumb]:h-2 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-osu-pink"
            />

            <audio
              ref={audioRef}
              src={previewUrl}
              preload="metadata"
              onLoadedMetadata={(e) => setDuration(e.currentTarget.duration || 0)}
              onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
              onEnded={stopPreview}
              onPause={() => setIsPreviewPlaying(false)}
              onPlay={() => setIsPreviewPlaying(true)}
              onError={() => {
                setPreviewError("Couldn't load preview");
                setIsPreviewPlaying(false);
              }}
            />
          </div>
        ) : null}
        {previewError ? (
          <div className="text-[10px] text-rose-300">{previewError}</div>
        ) : null}
      </div>
    </div>
  );
}
