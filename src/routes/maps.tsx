import { createFileRoute, stripSearchParams, useNavigate } from "@tanstack/react-router";
import { useState, useEffect, useMemo, useRef } from "react";
import { getRankings, getCountryMapsData } from "../lib/osu";
import { CLIENT_CACHE_TTL, isCacheStale } from "../lib/cache";
import { formatNumber, formatDuration, formatTimeAgo } from "../lib/format";
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
  MapsPlayerEntry,
} from "../lib/types";
import { useAppStore } from "../store";

// ── Types ──────────────────────────────────────────────────────────────────

type Tab = "farmed" | "popular" | "favourites";
type KeyFilter = "all" | "4k" | "7k" | "other";
type BeatmapSort = "plays" | "players" | "stars" | "length";
type FarmedSort = "players" | "avg-pp" | "max-pp" | "stars";
type StatusFilter = "all" | "ranked" | "loved" | "other";
type PpFilter = 0 | 500 | 700;
type ModFilter = "all" | "dt" | "ht" | "nm";
type MapsSearch = {
  tab?: Tab;
  page?: number;
  key?: KeyFilter;
  beatmapSort?: BeatmapSort;
  farmedSort?: FarmedSort;
  status?: StatusFilter;
  pp?: PpFilter;
  mod?: ModFilter;
  q?: string;
};

const PAGE_SIZE = 24;
const VISIBLE_AVATARS = 4;
const FARMED_SINGLE_PLAYER_PP_MIN = 500;
const DEFAULT_MAPS_SEARCH: Required<MapsSearch> = {
  tab: "farmed",
  page: 0,
  key: "all",
  beatmapSort: "players",
  farmedSort: "players",
  status: "all",
  pp: 0,
  mod: "all",
  q: "",
};

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
  if (filter === "ranked") return status === "ranked";
  if (filter === "loved") return status === "loved";
  return status !== "ranked" && status !== "loved";
}

function matchesSearch(title: string, artist: string, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  return title.toLowerCase().includes(q) || artist.toLowerCase().includes(q);
}

function hasValidMapsDataShape(data: CountryMapsData | null): data is CountryMapsData {
  if (!data) return false;
  if (!Array.isArray(data.farmed) || !Array.isArray(data.mostPlayed) || !Array.isArray(data.favourites)) {
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
  validateSearch: (search: Record<string, unknown>): Required<MapsSearch> => ({
    tab: search.tab === "popular" || search.tab === "favourites" ? search.tab : DEFAULT_MAPS_SEARCH.tab,
    page: Math.max(0, Number(search.page) || DEFAULT_MAPS_SEARCH.page),
    key: search.key === "4k" || search.key === "7k" || search.key === "other" ? search.key : DEFAULT_MAPS_SEARCH.key,
    beatmapSort: search.beatmapSort === "plays" || search.beatmapSort === "stars" || search.beatmapSort === "length" ? search.beatmapSort : DEFAULT_MAPS_SEARCH.beatmapSort,
    farmedSort: search.farmedSort === "avg-pp" || search.farmedSort === "max-pp" || search.farmedSort === "stars" ? search.farmedSort : DEFAULT_MAPS_SEARCH.farmedSort,
    status: search.status === "ranked" || search.status === "loved" || search.status === "other" ? search.status : DEFAULT_MAPS_SEARCH.status,
    pp: search.pp === 500 || search.pp === 700 ? search.pp : DEFAULT_MAPS_SEARCH.pp,
    mod: search.mod === "dt" || search.mod === "ht" || search.mod === "nm" ? search.mod : DEFAULT_MAPS_SEARCH.mod,
    q: typeof search.q === "string" ? search.q : DEFAULT_MAPS_SEARCH.q,
  }),
  component: MapsPage,
});

function buildMapsSearch(search: Required<MapsSearch>): MapsSearch {
  return {
    ...(search.tab !== "farmed" ? { tab: search.tab } : {}),
    ...(search.page > 0 ? { page: search.page } : {}),
    ...(search.key !== "all" ? { key: search.key } : {}),
    ...(search.beatmapSort !== "players" ? { beatmapSort: search.beatmapSort } : {}),
    ...(search.farmedSort !== "players" ? { farmedSort: search.farmedSort } : {}),
    ...(search.status !== "all" ? { status: search.status } : {}),
    ...(search.pp > 0 ? { pp: search.pp } : {}),
    ...(search.mod !== "all" ? { mod: search.mod } : {}),
    ...(search.q ? { q: search.q } : {}),
  };
}

function MapsPage() {
  const navigate = useNavigate();
  const mapsSearch = Route.useSearch();
  const rankings = useAppStore((s) => s.crRankings);
  const rankingsFetchedAt = useAppStore((s) => s.crRankingsFetchedAt);
  const mapsData = useAppStore((s) => s.mapsData);
  const mapsDataFetchedAt = useAppStore((s) => s.mapsDataFetchedAt);
  const setCrRankings = useAppStore((s) => s.setCrRankings);
  const setMapsData = useAppStore((s) => s.setMapsData);

  const [loadingPlayers, setLoadingPlayers] = useState(!rankings);
  const [loadingMaps, setLoadingMaps] = useState(!mapsData);
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

  const updateMapsSearch = (patch: Partial<Required<MapsSearch>>) => {
    navigate({
      to: "/maps",
      search: buildMapsSearch({
        ...mapsSearch,
        ...patch,
      }),
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
    getRankings({ data: { type: "performance", page: 1, country: "CR" } })
      .then((r) => {
        if (cancelled) return;
        setCrRankings(r);
      })
      .catch(() => {
        if (cancelled || rankings) return;
        setError("Couldn't load the player list.");
      })
      .finally(() => {
        if (!cancelled) setLoadingPlayers(false);
      });

    return () => { cancelled = true; };
  }, [rankings, rankingsFetchedAt, setCrRankings]);

  // Fetch maps data
  useEffect(() => {
    if (loadingPlayers || error || players.length === 0) return;

    let cancelled = false;
    const hasValidShape = hasValidMapsDataShape(mapsData);
    if (!isCacheStale(mapsDataFetchedAt, CLIENT_CACHE_TTL.mapsData) && hasValidShape) {
      setLoadingMaps(false);
      return () => { cancelled = true; };
    }

    setLoadingMaps(!mapsData);
    getCountryMapsData({ data: { users: players } })
      .then((data) => {
        if (cancelled) return;
        setMapsData(data);
      })
      .catch(() => {
        if (cancelled) return;
        if (!mapsData) setError("Couldn't load maps data. Try again later.");
      })
      .finally(() => {
        if (!cancelled) setLoadingMaps(false);
      });

    return () => { cancelled = true; };
  }, [loadingPlayers, error, mapsData, mapsDataFetchedAt, playerIdsKey, players, setMapsData]);

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
    tab === "farmed" ? filteredFarmed : tab === "popular" ? filteredMostPlayed : filteredFavourites;
  const totalPages = Math.ceil(currentList.length / PAGE_SIZE);
  const paginated = currentList.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  const tabs: { id: Tab; label: string }[] = [
    { id: "farmed", label: "most farmed" },
    { id: "popular", label: "widely played" },
    { id: "favourites", label: "community favorites" },
  ];

  const isLoading = loadingPlayers || loadingMaps;

  const hasActiveFilters =
    searchQuery || keyFilter !== "all" || statusFilter !== "all" || ppFilter > 0 || modFilter !== "all" || beatmapSort !== "players" || farmedSort !== "players" || tab !== "farmed";

  const resetFilters = () => {
    navigate({
      to: "/maps",
      search: {},
      replace: true,
    });
  };

  return (
    <div className="flex-1">
      <PageHeader
        iconSrc="/images/icons/rankings.svg"
        title="CR mania maps"
        right={
          <div className="flex items-center gap-2">
            {isLoading && !error && (
              <div className="flex items-center gap-1.5">
                <div className="w-3 h-3 border-2 border-osu-pink/40 border-t-osu-pink rounded-full animate-spin" />
                <span className="text-[10px] text-osu-f1">
                  {loadingPlayers ? "Loading players..." : "Aggregating maps data..."}
                </span>
              </div>
            )}
            {!isLoading && !error && mapsData && (
              <span className="text-[10px] text-osu-f1">
                {currentList.length} maps &middot; updated {formatTimeAgo(mapsData.generatedAt)}
              </span>
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
          {/* Search */}
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => updateMapsSearch({ q: e.target.value, page: 0 })}
            placeholder="Search title or artist..."
            className="bg-osu-b4 border border-osu-b3/30 rounded-lg px-3 py-1.5 text-[11px] text-osu-l2 placeholder:text-osu-f1 w-full sm:w-48 focus:outline-none focus:border-osu-pink/40 transition-colors"
          />

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
              {(["all", "ranked", "loved", "other"] as StatusFilter[]).map((s) => (
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
          {!error && isLoading && !mapsData && (
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
          )}

          {/* Card grid */}
          {!error && paginated.length > 0 && (
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

          {!error && !isLoading && currentList.length === 0 && (
            <div className="text-center py-16 text-osu-f1 text-sm">
              No maps match your filters
            </div>
          )}

          {/* Pagination */}
          <Pagination page={page} totalPages={totalPages} onPageChange={(p) => updateMapsSearch({ page: p })} />
        </div>
      </div>
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

function FilterPill({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`px-2 py-1 rounded text-[10px] font-medium transition-colors cursor-pointer ${
        active ? "bg-osu-pink/20 text-osu-pink-light" : "bg-osu-b4 text-osu-f1 hover:text-osu-l2 hover:bg-osu-b3"
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
    if (p.mods.includes("DT") || p.mods.includes("NC")) dtCount++;
    else if (p.mods.includes("HT")) htCount++;
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
    if (topPlayer.mods.includes("HT")) return "HT";
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
            <span className="text-[8px] text-osu-f1 uppercase">CR favs</span>
          </div>
          <div className="flex items-center gap-1">
            <span className="text-[11px] font-bold text-osu-l2" style={{ fontFamily: "Torus" }}>{formatNumber(fav.globalFavouriteCount)}</span>
            <span className="text-[8px] text-osu-f1 uppercase">global</span>
          </div>
        </div>

        <PlayerAvatars players={fav.players} onPlayerClick={onPlayerClick} />
      </div>
    </div>
  );
}
