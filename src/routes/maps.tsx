import { createFileRoute, stripSearchParams, useNavigate } from "@tanstack/react-router";
import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import {
  getRankings,
  getCountryMapsFarmed,
  getCountryMapsFavourites,
  rebuildCountryMapsFarmed,
  rebuildCountryMapsFavourites,
  rebuildCountryMapsData,
  rebuildCountryMapsForUser,
  composeCountryMapsData,
} from "../lib/osu";
import type { CountryMapsFarmedSection, CountryMapsFavouritesSection } from "../lib/osu";
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
type PpFilter = number;
type ModFilter = "all" | "dt" | "ht" | "nm";
type RandomWeight = "players" | "favourites";
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
  rStars: number;
  rStarsMax: number;
  rWeight: RandomWeight;
  rAvoidRepeats: boolean;
};

const PAGE_SIZE = 24;
const VISIBLE_AVATARS = 4;
const FARMED_SINGLE_PLAYER_PP_MIN = 500;
// When "avoid repeats" is on, recently-picked players/maps get 10× less weight
// rather than being excluded, so the advertised distribution still holds for
// fresh candidates but the feed doesn't stall on the same person/map.
const RECENT_BIAS = 0.1;
const RECENT_PLAYER_HISTORY = 2;
const RECENT_BEATMAP_HISTORY = 5;

function weightedPick<T>(items: T[], weight: (item: T) => number): T {
  let total = 0;
  for (const item of items) total += weight(item);
  if (total <= 0) return items[Math.floor(Math.random() * items.length)];
  let r = Math.random() * total;
  for (const item of items) {
    r -= weight(item);
    if (r <= 0) return item;
  }
  return items[items.length - 1];
}

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
  rStars: 0,
  rStarsMax: 0,
  rWeight: "players",
  rAvoidRepeats: false,
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
  "tiebreaker",
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
  tiebreaker: ["tiebreaker"],
};

const RANDOM_STAR_MIN = 2;
const RANDOM_STAR_MAX = 9;

const FARMED_PP_MIN = 200;
const FARMED_PP_MAX = 1000;
const FARMED_PP_STEP = 25;

const RANDOM_PATTERN_LABEL: Record<RandomPattern, string> = {
  jack: "Jack",
  chordjack: "Chordjack",
  stream: "Stream",
  jumpstream: "Jumpstream",
  stamina: "Stamina",
  tech: "Tech",
  ln: "LN",
  sv: "SV",
  tiebreaker: "Tiebreaker",
};

type TriStateMode = "include" | "exclude";
type TriStateSelection<T extends string> = { includes: Set<T>; excludes: Set<T> };

// URL encoding: `value` = include, `-value` = exclude. Backwards compatible
// with the previous toggle scheme (no prefix == include).
function parseTriStateCsv<T extends string>(raw: string, allowed: readonly T[]): TriStateSelection<T> {
  const includes = new Set<T>();
  const excludes = new Set<T>();
  if (!raw) return { includes, excludes };
  const allowedSet = new Set<string>(allowed);
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const isExclude = trimmed.startsWith("-");
    const value = isExclude ? trimmed.slice(1) : trimmed;
    if (!allowedSet.has(value)) continue;
    if (isExclude) excludes.add(value as T);
    else includes.add(value as T);
  }
  return { includes, excludes };
}

// Cycle: none → include → exclude → none
function cycleTriStateCsv(raw: string, value: string): string {
  const parts = raw ? raw.split(",").filter(Boolean) : [];
  const includeIdx = parts.indexOf(value);
  const excludeIdx = parts.indexOf(`-${value}`);
  if (includeIdx >= 0) {
    parts[includeIdx] = `-${value}`;
  } else if (excludeIdx >= 0) {
    parts.splice(excludeIdx, 1);
  } else {
    parts.push(value);
  }
  return parts.join(",");
}

function getTriStateMode<T extends string>(sel: TriStateSelection<T>, value: T): TriStateMode | undefined {
  if (sel.includes.has(value)) return "include";
  if (sel.excludes.has(value)) return "exclude";
  return undefined;
}

function triStateActive<T extends string>(sel: TriStateSelection<T>): number {
  return sel.includes.size + sel.excludes.size;
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
  if (typeof data.farmedGeneratedAt !== "string" || typeof data.favouritesGeneratedAt !== "string") {
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
    pp: (() => {
      const n = Number(search.pp);
      if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAPS_SEARCH.pp;
      const clamped = Math.min(Math.max(n, FARMED_PP_MIN), FARMED_PP_MAX);
      return Math.round(clamped / FARMED_PP_STEP) * FARMED_PP_STEP;
    })(),
    mod: search.mod === "dt" || search.mod === "ht" || search.mod === "nm" ? search.mod : DEFAULT_MAPS_SEARCH.mod,
    q: typeof search.q === "string" ? search.q : DEFAULT_MAPS_SEARCH.q,
    rStatus: typeof search.rStatus === "string" ? search.rStatus : DEFAULT_MAPS_SEARCH.rStatus,
    rKey: typeof search.rKey === "string" ? search.rKey : DEFAULT_MAPS_SEARCH.rKey,
    rPattern: typeof search.rPattern === "string" ? search.rPattern : DEFAULT_MAPS_SEARCH.rPattern,
    rStars: (() => {
      const n = Number(search.rStars);
      if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAPS_SEARCH.rStars;
      const clamped = Math.min(Math.max(n, RANDOM_STAR_MIN), RANDOM_STAR_MAX);
      return Math.round(clamped * 10) / 10;
    })(),
    rStarsMax: (() => {
      const n = Number(search.rStarsMax);
      if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAPS_SEARCH.rStarsMax;
      const clamped = Math.min(Math.max(n, RANDOM_STAR_MIN), RANDOM_STAR_MAX);
      return Math.round(clamped * 10) / 10;
    })(),
    rWeight: search.rWeight === "favourites" ? "favourites" : DEFAULT_MAPS_SEARCH.rWeight,
    rAvoidRepeats: typeof search.rAvoidRepeats === "boolean" ? search.rAvoidRepeats : DEFAULT_MAPS_SEARCH.rAvoidRepeats,
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
  const setRankings = useAppStore((s) => s.setRankings);
  const setMapsData = useAppStore((s) => s.setMapsData);
  const hasValidMapsData = hasValidMapsDataShape(mapsData);

  const [loadingPlayers, setLoadingPlayers] = useState(!rankings);
  const [loadingMaps, setLoadingMaps] = useState(!mapsData);
  const [loadedSections, setLoadedSections] = useState(0);
  const [rebuilding, setRebuilding] = useState(false);
  const [rebuildMenuOpen, setRebuildMenuOpen] = useState(false);
  const [rebuildQuery, setRebuildQuery] = useState("");
  const rebuildMenuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!rebuildMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (rebuildMenuRef.current && !rebuildMenuRef.current.contains(e.target as Node)) {
        setRebuildMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [rebuildMenuOpen]);
  const [error, setError] = useState<string | null>(null);
  const fetchingMapsRef = useRef(false);
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
  const rStars = mapsSearch.rStars;
  const rStarsMax = mapsSearch.rStarsMax;
  const rWeight = mapsSearch.rWeight;
  const rAvoidRepeats = mapsSearch.rAvoidRepeats;
  const randomStatus = useMemo(() => parseTriStateCsv(rStatusRaw, RANDOM_STATUS_OPTIONS), [rStatusRaw]);
  const randomKey = useMemo(() => parseTriStateCsv(rKeyRaw, RANDOM_KEY_OPTIONS), [rKeyRaw]);
  const randomPattern = useMemo(() => parseTriStateCsv(rPatternRaw, RANDOM_PATTERN_OPTIONS), [rPatternRaw]);
  // Expand umbrella tags ("Stream" → jumpstream/handstream/etc) on each side.
  const randomPatternCanonical = useMemo(() => {
    const expand = (set: Set<RandomPattern>): Set<string> | null => {
      if (set.size === 0) return null;
      const expanded = new Set<string>();
      for (const p of set) for (const c of RANDOM_PATTERN_MATCHES[p]) expanded.add(c);
      return expanded;
    };
    return { includes: expand(randomPattern.includes), excludes: expand(randomPattern.excludes) };
  }, [randomPattern]);
  const totalRandomActive = triStateActive(randomStatus) + triStateActive(randomKey) + triStateActive(randomPattern) + (rStars > 0 || rStarsMax > 0 ? 1 : 0);
  const countryName = getCountryName(selectedCountry);

  useEffect(() => {
    setLoadingPlayers(!rankings);
    setLoadingMaps(!mapsData || !hasValidMapsData);
    setLoadedSections(0);
    setError(null);
    fetchingMapsRef.current = false;
  }, [selectedCountry]);

  const updateMapsSearch = (patch: Partial<MapsSearch>) => {
    navigate({
      to: "/maps",
      search: { ...mapsSearch, ...patch },
      replace: true,
    });
  };

  const players =
    rankings?.ranking
      .filter((entry: RankingsResponse["ranking"][number]) => entry.user.is_active !== false)
      .slice(0, 50)
      .map((e: RankingsResponse["ranking"][number]) => ({
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

  // Fetch maps data in two parallel sections (farmed + favourites) so the
  // header can show incremental progress. We intentionally exclude mapsData /
  // hasValidMapsData / mapsDataFetchedAt from the dep array: those are derived
  // from the store this effect writes to, and including them would make the
  // effect re-trigger itself on every setMapsData and race with the cleanup.
  // fetchingMapsRef guards against concurrent fetches for the same country.
  useEffect(() => {
    if (loadingPlayers || error || players.length === 0) return;

    // Snapshot the current store state inside the effect rather than depending
    // on selectors, so a fresh-cache early return is safe from reruns.
    const snapshot = useAppStore.getState();
    const currentData = snapshot.mapsDataByCountry[selectedCountry] ?? null;
    const currentFetchedAt = snapshot.mapsDataFetchedAtByCountry[selectedCountry] ?? null;
    if (
      !isCacheStale(currentFetchedAt, CLIENT_CACHE_TTL.mapsData) &&
      hasValidMapsDataShape(currentData)
    ) {
      setLoadingMaps(false);
      setLoadedSections(2);
      return;
    }

    if (fetchingMapsRef.current) return;

    let cancelled = false;
    fetchingMapsRef.current = true;
    setLoadingMaps(true);
    setLoadedSections(0);

    const bumpSection = () => {
      if (!cancelled) setLoadedSections((n) => n + 1);
    };

    Promise.all([
      getCountryMapsFarmed({ data: { users: players } }).then((r) => {
        bumpSection();
        if (r.isStale) {
          rebuildCountryMapsFarmed({ data: { users: players } })
            .then((result) => {
              if (cancelled || !result.value) return;
              // Re-compose with the freshest farmed section; reuse current favourites.
              const state = useAppStore.getState();
              const existing = state.mapsDataByCountry[selectedCountry];
              if (!existing) return;
              setMapsData(selectedCountry, {
                ...existing,
                farmed: result.value.farmed,
                farmedGeneratedAt: result.value.generatedAt,
                generatedAt:
                  result.value.generatedAt < existing.favouritesGeneratedAt
                    ? result.value.generatedAt
                    : existing.favouritesGeneratedAt,
              });
            })
            .catch(() => {});
        }
        return r.value;
      }),
      getCountryMapsFavourites({ data: { users: players } }).then((r) => {
        bumpSection();
        if (r.isStale) {
          rebuildCountryMapsFavourites({ data: { users: players } })
            .then((result) => {
              if (cancelled || !result.value) return;
              const state = useAppStore.getState();
              const existing = state.mapsDataByCountry[selectedCountry];
              if (!existing) return;
              setMapsData(selectedCountry, {
                ...existing,
                mostPlayed: result.value.mostPlayed,
                favourites: result.value.favourites,
                favouritesByPlayer: result.value.favouritesByPlayer,
                beatmapsetsPool: result.value.beatmapsetsPool,
                favouritesGeneratedAt: result.value.generatedAt,
                generatedAt:
                  existing.farmedGeneratedAt < result.value.generatedAt
                    ? existing.farmedGeneratedAt
                    : result.value.generatedAt,
              });
            })
            .catch(() => {});
        }
        return r.value;
      }),
    ])
      .then(([farmedSection, favSection]: [CountryMapsFarmedSection, CountryMapsFavouritesSection]) => {
        if (cancelled) return;
        setMapsData(selectedCountry, composeCountryMapsData(farmedSection, favSection));
      })
      .catch(() => {
        if (cancelled) return;
        const state = useAppStore.getState();
        const existing = state.mapsDataByCountry[selectedCountry] ?? null;
        if (!hasValidMapsDataShape(existing)) {
          setError("Couldn't load maps data. Try again later.");
        }
      })
      .finally(() => {
        // If cancelled (country/players changed), a new fetch may already own
        // fetchingMapsRef — don't clear it out from under the new owner.
        if (cancelled) return;
        fetchingMapsRef.current = false;
        setLoadingMaps(false);
      });

    return () => {
      cancelled = true;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadingPlayers, error, playerIdsKey, selectedCountry]);

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

  // ── Random tab: pick a random top-50 player and a single random favourite ──
  const [randomPlayer, setRandomPlayer] = useState<MapsPlayerFavourites | null>(null);
  const [randomBeatmapset, setRandomBeatmapset] = useState<MapsFavouriteBeatmapset | null>(null);
  const lastRandomKeyRef = useRef<string | null>(null);
  // Sliding windows used when "avoid repeats" is on (see reshuffleRandom).
  const recentRandomPlayerIdsRef = useRef<number[]>([]);
  const recentRandomBeatmapIdsRef = useRef<number[]>([]);
  const [rerollMenuOpen, setRerollMenuOpen] = useState(false);
  const rerollMenuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!rerollMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (rerollMenuRef.current && !rerollMenuRef.current.contains(e.target as Node)) {
        setRerollMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [rerollMenuOpen]);

  // ── Mobile collapsible filter panel (shared across tabs) ────────────────
  const [filtersOpen, setFiltersOpen] = useState(false);
  const activeFilterCount = useMemo(() => {
    if (tab === "random") return totalRandomActive;
    if (tab === "farmed") {
      return (
        (keyFilter !== "all" ? 1 : 0) +
        (modFilter !== "all" ? 1 : 0) +
        (ppFilter > 0 ? 1 : 0) +
        (farmedSort !== "players" ? 1 : 0)
      );
    }
    if (tab === "popular") {
      return (keyFilter !== "all" ? 1 : 0) + (beatmapSort !== "players" ? 1 : 0);
    }
    if (tab === "favourites") return statusFilter !== "all" ? 1 : 0;
    return 0;
  }, [tab, totalRandomActive, keyFilter, modFilter, ppFilter, farmedSort, beatmapSort, statusFilter]);

  // Reset the panel when switching tabs so the new tab doesn't open mid-overlay.
  useEffect(() => { setFiltersOpen(false); }, [tab]);

  // Esc closes the mobile filter sheet (backdrop handles tap-outside).
  useEffect(() => {
    if (!filtersOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFiltersOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [filtersOpen]);

  // Swipe-down-to-dismiss on the sheet's drag handle.
  const [isDragging, setIsDragging] = useState(false);
  const [dragOffset, setDragOffset] = useState(0);
  const dragStartYRef = useRef(0);
  const handleDragStart = (e: React.TouchEvent) => {
    dragStartYRef.current = e.touches[0].clientY;
    setIsDragging(true);
    setDragOffset(0);
  };
  const handleDragMove = (e: React.TouchEvent) => {
    const delta = e.touches[0].clientY - dragStartYRef.current;
    setDragOffset(Math.max(0, delta));
  };
  const handleDragEnd = () => {
    setIsDragging(false);
    if (dragOffset > 80) setFiltersOpen(false);
    setDragOffset(0);
  };
  useEffect(() => { if (filtersOpen) setDragOffset(0); }, [filtersOpen]);

  const randomPool = useMemo(() => {
    if (!mapsData?.favouritesByPlayer || !mapsData?.beatmapsetsPool) return [];
    const pairs: Array<{ player: MapsPlayerFavourites; beatmapset: MapsFavouriteBeatmapset }> = [];
    for (const player of mapsData.favouritesByPlayer) {
      for (const bid of player.beatmapsetIds) {
        const beatmapset = mapsData.beatmapsetsPool[bid];
        if (!beatmapset) continue;
        const statusBucket = mapStatusBucket(beatmapset.status);
        if (randomStatus.includes.size > 0 && !randomStatus.includes.has(statusBucket)) continue;
        if (randomStatus.excludes.has(statusBucket)) continue;
        const keys = beatmapset.maniaKeys ?? [];
        if (randomKey.includes.size > 0 && !keys.some((k) => randomKey.includes.has(mapKeyBucket(k)))) continue;
        if (randomKey.excludes.size > 0 && keys.some((k) => randomKey.excludes.has(mapKeyBucket(k)))) continue;
        const patterns = beatmapset.patterns ?? [];
        if (randomPatternCanonical.includes && !patterns.some((p) => randomPatternCanonical.includes!.has(p))) continue;
        if (randomPatternCanonical.excludes && patterns.some((p) => randomPatternCanonical.excludes!.has(p))) continue;
        if (rStars > 0 && (beatmapset.starMax ?? 0) < rStars) continue;
        if (rStarsMax > 0 && (beatmapset.starMin ?? Number.MAX_VALUE) > rStarsMax) continue;
        pairs.push({ player, beatmapset });
      }
    }
    return pairs;
  }, [mapsData, randomStatus, randomKey, randomPatternCanonical, rStars, rStarsMax]);

  // Group eligible pairs by player so sampling can be uniform per-player
  // rather than per-pair (players with more favourites would otherwise win).
  const randomPlayerGroups = useMemo(() => {
    const byId = new Map<number, { player: MapsPlayerFavourites; beatmapsets: MapsFavouriteBeatmapset[] }>();
    for (const { player, beatmapset } of randomPool) {
      const g = byId.get(player.id);
      if (g) g.beatmapsets.push(beatmapset);
      else byId.set(player.id, { player, beatmapsets: [beatmapset] });
    }
    return [...byId.values()];
  }, [randomPool]);

  const reshuffleRandom = useCallback(() => {
    if (randomPlayerGroups.length === 0) {
      setRandomPlayer(null);
      setRandomBeatmapset(null);
      return;
    }
    const recentPlayers = rAvoidRepeats ? new Set(recentRandomPlayerIdsRef.current) : null;
    const recentMaps = rAvoidRepeats ? new Set(recentRandomBeatmapIdsRef.current) : null;

    let pickedPlayer: MapsPlayerFavourites;
    let pickedBeatmapset: MapsFavouriteBeatmapset;

    if (rWeight === "favourites") {
      // "Equal chance per map": sample a (player, beatmapset) pair uniformly
      // so every eligible favourite is equally likely. Players with bigger
      // collections show up more often as a side-effect.
      const pair = weightedPick(randomPool, (p) => {
        let w = 1;
        if (recentPlayers?.has(p.player.id)) w *= RECENT_BIAS;
        if (recentMaps?.has(p.beatmapset.id)) w *= RECENT_BIAS;
        return w;
      });
      pickedPlayer = pair.player;
      pickedBeatmapset = pair.beatmapset;
    } else {
      // "Equal chance per player": pick a player uniformly, then pick one of
      // their eligible favourites uniformly.
      const group = weightedPick(randomPlayerGroups, (g) =>
        recentPlayers?.has(g.player.id) ? RECENT_BIAS : 1,
      );
      pickedPlayer = group.player;
      pickedBeatmapset = weightedPick(group.beatmapsets, (b) =>
        recentMaps?.has(b.id) ? RECENT_BIAS : 1,
      );
    }

    if (rAvoidRepeats) {
      const nextPlayers = [...recentRandomPlayerIdsRef.current, pickedPlayer.id];
      if (nextPlayers.length > RECENT_PLAYER_HISTORY) nextPlayers.shift();
      recentRandomPlayerIdsRef.current = nextPlayers;

      const nextMaps = [...recentRandomBeatmapIdsRef.current, pickedBeatmapset.id];
      if (nextMaps.length > RECENT_BEATMAP_HISTORY) nextMaps.shift();
      recentRandomBeatmapIdsRef.current = nextMaps;
    }

    setRandomPlayer(pickedPlayer);
    setRandomBeatmapset(pickedBeatmapset);
  }, [randomPlayerGroups, randomPool, rWeight, rAvoidRepeats]);

  // Only reshuffle on first entry to the tab or when the underlying data
  // changes (country switch / rebuild). Filter changes never auto-reroll —
  // the user must click Reroll explicitly.
  useEffect(() => {
    if (tab !== "random" || !mapsData) return;
    const dataKey = `${selectedCountry}:${mapsData.favouritesGeneratedAt}`;
    const dataChanged = lastRandomKeyRef.current !== dataKey;
    lastRandomKeyRef.current = dataKey;
    if (dataChanged || !randomBeatmapset) reshuffleRandom();
  }, [tab, selectedCountry, mapsData, reshuffleRandom, randomBeatmapset]);

  const hasActiveFilters =
    tab === "random"
      ? totalRandomActive > 0
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

  const handleDevRebuildAll = async () => {
    if (rebuilding || players.length === 0) return;
    setRebuilding(true);
    setRebuildMenuOpen(false);
    try {
      const result = await rebuildCountryMapsData({ data: { users: players } });
      if (result.value) setMapsData(selectedCountry, result.value);
    } catch {
      setError("Rebuild failed.");
    } finally {
      setRebuilding(false);
    }
  };

  const handleDevRebuildUser = async (userId: number) => {
    if (rebuilding || players.length === 0) return;
    setRebuilding(true);
    setRebuildMenuOpen(false);
    setRebuildQuery("");
    try {
      const result = await rebuildCountryMapsForUser({ data: { users: players, userId } });
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
          <div className="flex flex-wrap items-center gap-2 sm:justify-end">
            {isLoading && !error && (
              <div className="flex items-center gap-1.5">
                <div className="w-3 h-3 border-2 border-osu-pink/40 border-t-osu-pink rounded-full animate-spin" />
                <span className="text-[10px] text-osu-f1 tabular-nums">
                  {loadingPlayers
                    ? "Loading players..."
                    : `Loading maps... (${Math.round((loadedSections / 2) * 100)}%)`}
                </span>
              </div>
            )}
            {!isLoading && !error && mapsData && (
              <span className="text-[10px] text-osu-f1">
                {tab === "random" ? randomPool.length : currentList.length} maps &middot; updated {formatTimeAgo(tab === "farmed" ? mapsData.farmedGeneratedAt : mapsData.favouritesGeneratedAt)}
              </span>
            )}
            {isDevMode && !isLoading && !error && mapsData && (
              <div ref={rebuildMenuRef} className="relative">
                <div className="flex items-stretch rounded-lg bg-osu-red/20 border border-osu-red/30 overflow-hidden">
                  <button
                    onClick={handleDevRebuildAll}
                    disabled={rebuilding}
                    className="px-2 py-1 text-[10px] text-osu-red font-semibold hover:bg-osu-red/30 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                    title="Force rebuild maps data for everyone (dev only)"
                  >
                    {rebuilding ? "Rebuilding..." : "Rebuild"}
                  </button>
                  <div className="w-px bg-osu-red/30" />
                  <button
                    onClick={() => setRebuildMenuOpen((v) => !v)}
                    disabled={rebuilding}
                    aria-label="Rebuild for a specific player"
                    aria-expanded={rebuildMenuOpen}
                    className="px-1.5 flex items-center text-osu-red hover:bg-osu-red/30 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className={`w-3 h-3 transition-transform ${rebuildMenuOpen ? "rotate-180" : ""}`}>
                      <polyline points="6 9 12 15 18 9" />
                    </svg>
                  </button>
                </div>
                {rebuildMenuOpen && (
                  <div className="absolute right-0 top-full mt-2 w-[240px] rounded-lg bg-osu-b4 border border-osu-b3 shadow-xl z-20 flex flex-col">
                    <div className="px-3 pt-2 pb-1 text-[9px] uppercase tracking-wider text-osu-f1 font-semibold">
                      Rebuild just one player
                    </div>
                    <input
                      type="text"
                      value={rebuildQuery}
                      onChange={(e) => setRebuildQuery(e.target.value)}
                      placeholder="Search player..."
                      className="mx-1 mb-1 px-2 py-1 rounded-md bg-osu-b5 border border-osu-b3/60 text-[11px] text-osu-l2 placeholder:text-osu-f1 focus:outline-none focus:border-osu-pink/40"
                      autoFocus
                    />
                    <div className="max-h-[240px] overflow-y-auto">
                      {players
                        .filter((p) => p.username.toLowerCase().includes(rebuildQuery.toLowerCase()))
                        .map((p) => (
                          <button
                            key={p.id}
                            onClick={() => handleDevRebuildUser(p.id)}
                            disabled={rebuilding}
                            className="w-full text-left px-3 py-1.5 text-[11px] text-osu-l2 hover:bg-osu-b3 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed truncate"
                          >
                            {p.username}
                          </button>
                        ))}
                      {players.filter((p) => p.username.toLowerCase().includes(rebuildQuery.toLowerCase())).length === 0 && (
                        <div className="px-3 py-2 text-[10px] text-osu-f1">No matches</div>
                      )}
                    </div>
                  </div>
                )}
              </div>
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
        <div className="max-w-[1200px] mx-auto px-4 sm:px-5 py-2.5 flex flex-wrap items-start sm:items-center gap-x-4 gap-y-2">
          {tab !== "random" && (
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => updateMapsSearch({ q: e.target.value, page: 0 })}
              placeholder="Search title or artist..."
              className="bg-osu-b4 border border-osu-b3/30 rounded-lg px-3 py-1.5 text-[11px] text-osu-l2 placeholder:text-osu-f1 w-full sm:w-48 focus:outline-none focus:border-osu-pink/40 transition-colors"
            />
          )}

          {/* Mobile-only summary row: filter toggle + (random) match count */}
          <div className="flex w-full items-center justify-between gap-2 sm:hidden">
            <button
              onClick={() => setFiltersOpen((o) => !o)}
              aria-expanded={filtersOpen}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-osu-b4 border border-osu-b3/30 text-[11px] text-osu-l2 hover:bg-osu-b3 transition-colors cursor-pointer"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-3 h-3">
                <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
              </svg>
              <span>Filters</span>
              {activeFilterCount > 0 && (
                <span className="inline-flex min-w-[18px] h-[18px] shrink-0 items-center justify-center self-center rounded-full bg-osu-pink/30 px-1 text-[10px] font-bold leading-none text-osu-pink-light tabular-nums">
                  <span className="relative -top-px">{activeFilterCount}</span>
                </span>
              )}
            </button>
            {tab === "random" && (
              <span className="text-[10px] text-osu-f1">
                {randomPool.length} {randomPool.length === 1 ? "match" : "matches"}
              </span>
            )}
          </div>

          {/* Mobile dimming backdrop (always mounted so opacity can fade). */}
          <div
            onClick={() => setFiltersOpen(false)}
            aria-hidden="true"
            className="fixed inset-0 z-40 bg-black/35 sm:hidden transition-opacity duration-300 ease-out"
            style={{
              opacity: filtersOpen ? Math.max(0, 1 - dragOffset / 250) : 0,
              pointerEvents: filtersOpen ? "auto" : "none",
            }}
          />

          {/* Filter content: inline on desktop (display: contents), bottom
              sheet on mobile so it doesn't cover the page content above.
              Always mounted on mobile so transform transitions animate. */}
          <div
            className="sm:contents sm:!pointer-events-auto fixed bottom-0 left-0 right-0 z-50 max-h-[75vh] overflow-y-auto bg-osu-d5 border-t border-osu-b3/30 rounded-t-2xl shadow-2xl px-4 pt-2 pb-6 flex flex-col gap-3 will-change-transform"
            style={{
              transform: filtersOpen ? `translateY(${dragOffset}px)` : "translateY(105%)",
              transition: isDragging ? "none" : "transform 280ms cubic-bezier(0.32, 0.72, 0, 1)",
              pointerEvents: filtersOpen ? "auto" : "none",
            }}
            role={filtersOpen ? "dialog" : undefined}
            aria-modal={filtersOpen ? true : undefined}
          >
            {/* Drag handle pill — also the swipe-to-dismiss touch zone */}
            <div
              onTouchStart={handleDragStart}
              onTouchMove={handleDragMove}
              onTouchEnd={handleDragEnd}
              onTouchCancel={handleDragEnd}
              className="sm:hidden flex justify-center pt-2 pb-3 -mx-4 cursor-grab touch-none"
            >
              <div className="h-1 w-10 rounded-full bg-osu-b3" />
            </div>

            {/* Sheet header: title + close button */}
            <div className="sm:hidden flex items-center justify-between">
              <div className="flex items-center gap-2">
                <h3 className="text-[12px] font-bold text-osu-l2 uppercase tracking-wider">Filters</h3>
                {activeFilterCount > 0 && (
                  <span className="inline-flex min-w-[18px] h-[18px] shrink-0 items-center justify-center self-center rounded-full bg-osu-pink/30 px-1 text-[10px] font-bold leading-none text-osu-pink-light tabular-nums">
                    <span className="relative -top-px">{activeFilterCount}</span>
                  </span>
                )}
              </div>
              <button
                onClick={() => setFiltersOpen(false)}
                aria-label="Close filters"
                className="p-1 text-osu-f1 hover:text-white transition-colors cursor-pointer"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
              {tab === "random" && (
                <>
                  <FilterGroup label="Status">
                    {RANDOM_STATUS_OPTIONS.map((s) => (
                      <TriStatePill
                        key={s}
                        mode={getTriStateMode(randomStatus, s)}
                        hasAnyActive={triStateActive(randomStatus) > 0}
                        onClick={() => updateMapsSearch({ rStatus: cycleTriStateCsv(rStatusRaw, s) })}
                      >
                        {s.charAt(0).toUpperCase() + s.slice(1)}
                      </TriStatePill>
                    ))}
                  </FilterGroup>

                  <FilterGroup label="Keys">
                    {RANDOM_KEY_OPTIONS.map((k) => (
                      <TriStatePill
                        key={k}
                        mode={getTriStateMode(randomKey, k)}
                        hasAnyActive={triStateActive(randomKey) > 0}
                        onClick={() => updateMapsSearch({ rKey: cycleTriStateCsv(rKeyRaw, k) })}
                      >
                        {k.toUpperCase()}
                      </TriStatePill>
                    ))}
                  </FilterGroup>

                  <FilterGroup label="Tags">
                    {RANDOM_PATTERN_OPTIONS.map((p) => (
                      <TriStatePill
                        key={p}
                        mode={getTriStateMode(randomPattern, p)}
                        hasAnyActive={triStateActive(randomPattern) > 0}
                        onClick={() => updateMapsSearch({ rPattern: cycleTriStateCsv(rPatternRaw, p) })}
                      >
                        {RANDOM_PATTERN_LABEL[p]}
                      </TriStatePill>
                    ))}
                  </FilterGroup>

                  <FilterGroup label="★ range">
                    <StarRangeSlider
                      min={rStars}
                      max={rStarsMax}
                      onChange={(nextMin, nextMax) => updateMapsSearch({ rStars: nextMin, rStarsMax: nextMax })}
                    />
                  </FilterGroup>

                  <span className="hidden sm:inline text-[10px] text-osu-f1">
                    {randomPool.length} {randomPool.length === 1 ? "match" : "matches"}
                  </span>
                </>
              )}

              {tab === "farmed" && (
                <>
                  <FilterGroup label="Keys">
                    {(["all", "4k", "7k", "other"] as KeyFilter[]).map((k) => (
                      <FilterPill key={k} active={keyFilter === k} onClick={() => updateMapsSearch({ key: k, page: 0 })}>
                        {k === "all" ? "All" : k.toUpperCase()}
                      </FilterPill>
                    ))}
                  </FilterGroup>

                  <FilterGroup label="Mods">
                    {(["all", "dt", "ht", "nm"] as ModFilter[]).map((m) => (
                      <FilterPill key={m} active={modFilter === m} onClick={() => updateMapsSearch({ mod: m, page: 0 })}>
                        {m === "all" ? "All" : m === "nm" ? "NM" : m.toUpperCase()}
                      </FilterPill>
                    ))}
                  </FilterGroup>

                  <FilterGroup label="Min PP">
                    <MinPpSlider
                      value={ppFilter}
                      onChange={(v) => updateMapsSearch({ pp: v, page: 0 })}
                    />
                  </FilterGroup>

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
          </div>

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
        <div className="max-w-[1200px] mx-auto px-4 sm:px-5 py-6">
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
                  <div className="flex flex-row items-center justify-between gap-3">
                    <button
                      onClick={() => navigate({ to: "/player/$username", params: { username: randomPlayer.username } })}
                      className="flex items-center gap-3 group cursor-pointer min-w-0 text-left"
                    >
                      <Avatar url={randomPlayer.avatarUrl} size={44} />
                      <div className="min-w-0">
                        <div className="text-[10px] uppercase tracking-wider text-osu-f1">
                          random pick from
                        </div>
                        <div className="text-[15px] font-semibold text-osu-l2 group-hover:text-white transition-colors truncate">
                          {randomPlayer.username}
                        </div>
                        <div className="text-[10px] text-osu-f1">
                          {randomPlayer.beatmapsetIds.length} favourites
                        </div>
                      </div>
                    </button>
                    <div ref={rerollMenuRef} className="shrink-0 relative">
                      <div className="flex items-stretch rounded-lg bg-osu-pink/20 border border-osu-pink/30 overflow-hidden">
                        <button
                          onClick={() => { setRerollMenuOpen(false); reshuffleRandom(); }}
                          className="px-3 py-1.5 text-[11px] text-osu-pink-light font-semibold hover:bg-osu-pink/30 transition-colors cursor-pointer"
                        >
                          Reroll
                        </button>
                        <div className="w-px bg-osu-pink/30" />
                        <button
                          onClick={() => setRerollMenuOpen((v) => !v)}
                          aria-label="Reroll settings"
                          aria-expanded={rerollMenuOpen}
                          className="px-1.5 flex items-center text-osu-pink-light hover:bg-osu-pink/30 transition-colors cursor-pointer"
                        >
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className={`w-3 h-3 transition-transform ${rerollMenuOpen ? "rotate-180" : ""}`}>
                            <polyline points="6 9 12 15 18 9" />
                          </svg>
                        </button>
                      </div>
                      {rerollMenuOpen && (
                        <div className="absolute right-0 top-full mt-2 w-[280px] rounded-lg bg-osu-b4 border border-osu-b3 shadow-xl p-1 z-20">
                          <div className="px-3 pt-2 pb-1 text-[9px] uppercase tracking-wider text-osu-f1 font-semibold">
                            How to pick
                          </div>
                          {([
                            {
                              id: "players" as const,
                              label: "Equal chance per player",
                              desc: "Each player is equally likely, no matter how many favourites they have.",
                            },
                            {
                              id: "favourites" as const,
                              label: "Equal chance per map",
                              desc: "Every favourited map is equally likely. Players with bigger collections show up more often as a result.",
                            },
                          ]).map((opt) => {
                            const active = rWeight === opt.id;
                            return (
                              <button
                                key={opt.id}
                                onClick={() => {
                                  updateMapsSearch({ rWeight: opt.id });
                                  setRerollMenuOpen(false);
                                }}
                                className={`w-full text-left p-2.5 rounded-md transition-colors cursor-pointer ${active ? "bg-osu-pink/15" : "hover:bg-osu-b3"}`}
                              >
                                <div className="flex items-center justify-between gap-2">
                                  <span className={`text-[12px] font-semibold ${active ? "text-osu-pink-light" : "text-osu-l2"}`}>
                                    {opt.label}
                                  </span>
                                  {active && (
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="w-3 h-3 text-osu-pink-light shrink-0">
                                      <polyline points="20 6 9 17 4 12" />
                                    </svg>
                                  )}
                                </div>
                                <div className="mt-0.5 text-[10px] text-osu-f1 leading-snug">
                                  {opt.desc}
                                </div>
                              </button>
                            );
                          })}
                          <div className="h-px bg-osu-b3 mx-2 my-1" />
                          <button
                            onClick={() => updateMapsSearch({ rAvoidRepeats: !rAvoidRepeats })}
                            className="w-full text-left p-2.5 rounded-md transition-colors cursor-pointer hover:bg-osu-b3"
                          >
                            <div className="flex items-center justify-between gap-2">
                              <span className="text-[12px] font-semibold text-osu-l2">
                                Avoid repeats
                              </span>
                              <span
                                className={`relative inline-flex h-4 w-7 shrink-0 rounded-full transition-colors ${rAvoidRepeats ? "bg-osu-pink" : "bg-osu-b3"}`}
                                aria-hidden
                              >
                                <span
                                  className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-transform ${rAvoidRepeats ? "translate-x-3.5" : "translate-x-0.5"}`}
                                />
                              </span>
                            </div>
                            <div className="mt-0.5 text-[10px] text-osu-f1 leading-snug">
                              Makes recent picks much less likely.
                            </div>
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                  <div key={`random-${randomPlayer.id}-${randomBeatmapset.id}`} className="cards-enter">
                    <RandomCard bm={randomBeatmapset} />
                  </div>
                </>
              ) : (
                <div className="text-center py-16 text-osu-f1 text-sm">
                  {hasActiveFilters
                    ? "No favourites match your filters. Try loosening them."
                    : "No favourites found for any player in the top 50."}
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
    <div className="flex w-full min-w-0 flex-col gap-1 sm:w-auto sm:flex-row sm:items-center sm:gap-1.5">
      <span className="text-[9px] uppercase tracking-wider text-osu-f1 font-semibold shrink-0">{label}</span>
      <div className="flex min-w-0 flex-wrap gap-0.5">{children}</div>
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

// Tri-state pill for random filters: click cycles none → include → exclude → none.
// Include = pink fill, exclude = red fill with strikethrough overlay.
function TriStatePill({
  mode,
  hasAnyActive,
  onClick,
  children,
}: {
  mode: TriStateMode | undefined;
  hasAnyActive: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  const styleClass = mode === "include"
    ? "bg-osu-pink/20 text-osu-pink-light"
    : mode === "exclude"
      ? "bg-osu-red/15 text-osu-red border border-osu-red/40"
      : hasAnyActive
        ? "bg-osu-b4/60 text-osu-f1/70 hover:text-osu-l2 hover:bg-osu-b3"
        : "bg-osu-b4 text-osu-f1 hover:text-osu-l2 hover:bg-osu-b3";
  const title = mode === "include"
    ? "Including (click to exclude)"
    : mode === "exclude"
      ? "Excluding (click to clear)"
      : "Click to include";
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      className={`relative px-2 py-1 rounded text-[10px] font-medium transition-colors cursor-pointer ${styleClass}`}
    >
      <span className={mode === "exclude" ? "opacity-60" : ""}>{children}</span>
      {mode === "exclude" && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute left-1.5 right-1.5 top-1/2 h-[1.5px] -translate-y-1/2 rotate-[-8deg] rounded-full bg-osu-red/80"
        />
      )}
    </button>
  );
}

// Dual-thumb range slider for "★ range". Props use 0 as "unset" for each side:
// min=0 → thumb at floor, max=0 → thumb at ceiling. Commits on release,
// rounded to 0.1, clamping thumbs from crossing with a 0.1-star gap.
function StarRangeSlider({
  min,
  max,
  onChange,
}: {
  min: number;
  max: number;
  onChange: (nextMin: number, nextMax: number) => void;
}) {
  const active = min > 0 || max > 0;
  const resolvedMin = min > 0 ? min : RANDOM_STAR_MIN;
  const resolvedMax = max > 0 ? max : RANDOM_STAR_MAX;
  const [localMin, setLocalMin] = useState<number>(resolvedMin);
  const [localMax, setLocalMax] = useState<number>(resolvedMax);
  const [isDragging, setIsDragging] = useState(false);
  const draggingRef = useRef(false);

  useEffect(() => {
    if (draggingRef.current) return;
    setLocalMin(min > 0 ? min : RANDOM_STAR_MIN);
    setLocalMax(max > 0 ? max : RANDOM_STAR_MAX);
  }, [min, max]);

  const commit = () => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    setIsDragging(false);
    const round = (n: number) => Math.round(n * 10) / 10;
    const nextMin = round(localMin);
    const nextMax = round(localMax);
    onChange(
      nextMin <= RANDOM_STAR_MIN ? 0 : nextMin,
      nextMax >= RANDOM_STAR_MAX ? 0 : nextMax,
    );
  };

  const show = active || isDragging;
  const span = RANDOM_STAR_MAX - RANDOM_STAR_MIN;
  const minPct = ((localMin - RANDOM_STAR_MIN) / span) * 100;
  const maxPct = ((localMax - RANDOM_STAR_MIN) / span) * 100;

  const atFloor = localMin <= RANDOM_STAR_MIN + 1e-6;
  const atCeiling = localMax >= RANDOM_STAR_MAX - 1e-6;
  const label = !show
    ? "—"
    : atFloor && atCeiling
      ? "Any"
      : atCeiling
        ? `${localMin.toFixed(1)}★+`
        : atFloor
          ? `≤${localMax.toFixed(1)}★`
          : `${localMin.toFixed(1)}-${localMax.toFixed(1)}★`;

  // Put the thumb closer to the centre on top so it's always reachable when
  // the thumbs meet. Push the min thumb to the front once it's past 50%.
  const minOnTop = localMin - RANDOM_STAR_MIN > span / 2;

  const thumbClasses =
    "[&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-osu-pink-light [&::-webkit-slider-thumb]:shadow-[0_0_0_2px_rgba(0,0,0,0.35)] [&::-webkit-slider-thumb]:cursor-grab [&::-webkit-slider-thumb]:pointer-events-auto" +
    " [&::-moz-range-thumb]:appearance-none [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:w-3 [&::-moz-range-thumb]:h-3 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-osu-pink-light [&::-moz-range-thumb]:shadow-[0_0_0_2px_rgba(0,0,0,0.35)] [&::-moz-range-thumb]:cursor-grab [&::-moz-range-thumb]:pointer-events-auto";

  return (
    <div className="flex items-center gap-2 w-full sm:w-auto">
      <button
        type="button"
        onClick={() => onChange(0, 0)}
        className={`px-2 py-1 rounded text-[10px] font-medium transition-colors cursor-pointer shrink-0 ${
          !active
            ? "bg-osu-pink/20 text-osu-pink-light"
            : "bg-osu-b4/60 text-osu-f1/70 hover:text-osu-l2 hover:bg-osu-b3"
        }`}
      >
        Any
      </button>
      <div className={`relative flex-1 sm:w-28 h-3 transition-opacity ${show ? "" : "opacity-60"}`}>
        <div
          className="absolute top-1/2 -translate-y-1/2 inset-x-0 h-1 rounded-full"
          style={{ background: "var(--color-osu-b3)" }}
        />
        {show && (
          <div
            className="absolute top-1/2 -translate-y-1/2 h-1 rounded-full"
            style={{
              background: "var(--color-osu-pink)",
              left: `${minPct}%`,
              right: `${100 - maxPct}%`,
            }}
          />
        )}
        <input
          type="range"
          min={RANDOM_STAR_MIN}
          max={RANDOM_STAR_MAX}
          step="any"
          value={localMin}
          onChange={(e) => {
            const v = Math.min(Number(e.target.value), localMax - 0.1);
            draggingRef.current = true;
            setIsDragging(true);
            setLocalMin(Math.max(RANDOM_STAR_MIN, v));
          }}
          onMouseUp={commit}
          onTouchEnd={commit}
          onKeyUp={commit}
          aria-label="Minimum star rating"
          className={`absolute inset-0 w-full h-full appearance-none bg-transparent pointer-events-none ${thumbClasses}`}
          style={{ zIndex: minOnTop ? 3 : 2 }}
        />
        <input
          type="range"
          min={RANDOM_STAR_MIN}
          max={RANDOM_STAR_MAX}
          step="any"
          value={localMax}
          onChange={(e) => {
            const v = Math.max(Number(e.target.value), localMin + 0.1);
            draggingRef.current = true;
            setIsDragging(true);
            setLocalMax(Math.min(RANDOM_STAR_MAX, v));
          }}
          onMouseUp={commit}
          onTouchEnd={commit}
          onKeyUp={commit}
          aria-label="Maximum star rating"
          className={`absolute inset-0 w-full h-full appearance-none bg-transparent pointer-events-none ${thumbClasses}`}
          style={{ zIndex: minOnTop ? 2 : 3 }}
        />
      </div>
      <span className="text-[10px] font-semibold tabular-nums text-left text-osu-pink-light shrink-0">
        {label}
      </span>
    </div>
  );
}

// Single-thumb slider for farmed "Min PP". Commits on release, rounded to
// FARMED_PP_STEP. 0 = filter disabled (thumb at floor).
function MinPpSlider({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const active = value > 0;
  const [localValue, setLocalValue] = useState<number>(active ? value : FARMED_PP_MIN);
  const [isDragging, setIsDragging] = useState(false);
  const draggingRef = useRef(false);

  useEffect(() => {
    if (!draggingRef.current) setLocalValue(active ? value : FARMED_PP_MIN);
  }, [value, active]);

  const commit = () => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    setIsDragging(false);
    const snapped = Math.round(localValue / FARMED_PP_STEP) * FARMED_PP_STEP;
    onChange(snapped <= FARMED_PP_MIN ? 0 : snapped);
  };

  const show = active || isDragging;
  const pct = ((localValue - FARMED_PP_MIN) / (FARMED_PP_MAX - FARMED_PP_MIN)) * 100;
  const trackColor = "var(--color-osu-b3)";
  const fillColor = "var(--color-osu-pink)";
  const background = show
    ? `linear-gradient(to right, ${fillColor} 0%, ${fillColor} ${pct}%, ${trackColor} ${pct}%, ${trackColor} 100%)`
    : trackColor;

  return (
    <div className="flex items-center gap-2 w-full sm:w-auto">
      <button
        type="button"
        onClick={() => onChange(0)}
        className={`px-2 py-1 rounded text-[10px] font-medium transition-colors cursor-pointer shrink-0 ${
          !active
            ? "bg-osu-pink/20 text-osu-pink-light"
            : "bg-osu-b4/60 text-osu-f1/70 hover:text-osu-l2 hover:bg-osu-b3"
        }`}
      >
        Any
      </button>
      <input
        type="range"
        min={FARMED_PP_MIN}
        max={FARMED_PP_MAX}
        step={FARMED_PP_STEP}
        value={localValue}
        onChange={(e) => {
          draggingRef.current = true;
          setIsDragging(true);
          setLocalValue(Number(e.target.value));
        }}
        onMouseUp={commit}
        onTouchEnd={commit}
        onKeyUp={commit}
        aria-label="Minimum PP"
        style={{ background }}
        className={`flex-1 sm:w-28 h-1 appearance-none rounded-full cursor-pointer
          [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-osu-pink-light [&::-webkit-slider-thumb]:shadow-[0_0_0_2px_rgba(0,0,0,0.35)] [&::-webkit-slider-thumb]:cursor-grab
          [&::-moz-range-thumb]:appearance-none [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:w-3 [&::-moz-range-thumb]:h-3 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-osu-pink-light [&::-moz-range-thumb]:shadow-[0_0_0_2px_rgba(0,0,0,0.35)] [&::-moz-range-thumb]:cursor-grab
          transition-opacity ${show ? "" : "opacity-60"}`}
      />
      <span className="text-[10px] font-semibold tabular-nums text-left text-osu-pink-light shrink-0">
        {show ? `${Math.round(localValue)}pp+` : "—"}
      </span>
    </div>
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

  // Some beatmapsets have no background image — the cover URL 404s. Track load
  // failure so we can swap in a deterministic gradient fallback.
  const [coverBroken, setCoverBroken] = useState(false);
  const [coverLoaded, setCoverLoaded] = useState(false);
  useEffect(() => {
    setCoverBroken(false);
    setCoverLoaded(false);
  }, [bm.id]);

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
        <div className="w-full h-[220px] bg-osu-b6">
          {!coverBroken && (
            <img
              src={bm.covers.cover}
              alt=""
              className={`w-full h-full object-cover transition-opacity duration-500 ${coverLoaded ? "opacity-100" : "opacity-0"}`}
              loading="lazy"
              onLoad={() => setCoverLoaded(true)}
              onError={() => setCoverBroken(true)}
            />
          )}
        </div>
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
        <div className="absolute top-3 right-3 flex max-w-[calc(100%-5.5rem)] flex-wrap items-center justify-end gap-1">
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
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[11px] text-osu-f1 truncate">mapped by {bm.creator}</div>
            {bm.bpm > 0 && (
              <div className="text-[10px] text-osu-f1/80 truncate">{Math.round(bm.bpm)} BPM</div>
            )}
          </div>
          <div className="flex w-full items-center justify-between gap-4 sm:w-auto sm:justify-start flex-shrink-0">
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
          <div className="flex flex-wrap items-center gap-2">
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

            <div className="flex min-w-0 flex-1 items-center gap-2">
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
            </div>

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
