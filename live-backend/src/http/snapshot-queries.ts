import type { FarmHelperKeyMode, FarmHelperView } from "../features/farm-helper.js";
import type { GlobalRankingsSort } from "../features/global-rankings.js";
import { isLeaderboardAxis, isSkillLeaderboardKeyCount, SKILL_LEADERBOARD_MAX_PAGE_SIZE, type DanSide } from "../features/skill-leaderboards.js";
import { MAP_SEARCH_PATTERNS, MAP_SEARCH_SUB_PATTERNS, type MapSearchQuery, type MapSearchSort } from "../features/map-search.js";
import { MAPS_RANDOM_DRAW_DEFAULT_COUNT, MAPS_RANDOM_DRAW_EXCLUDE_SETS_MAX, MAPS_RANDOM_DRAW_EXCLUDE_USERS_MAX, MAPS_RANDOM_DRAW_HIDE_USERS_MAX, MAPS_RANDOM_DRAW_MAX_COUNT, MAPS_RANDOM_DRAW_STAR_MAX, MAPS_RANDOM_KEY_BUCKETS, MAPS_RANDOM_PATTERN_NAMES, MAPS_RANDOM_STATUS_BUCKETS, type MapsPageQuery, type MapsPlayersKind, type MapsRandomDrawQuery } from "../features/maps.js";
import type { MyDataTopPlaysQuery, MyDataTrackedFeedQuery } from "../features/my-data.js";
import type { TopPlaysSnapshotOptions } from "../features/top-plays.js";
import type { TrackerSnapshotFilters } from "../features/tracker.js";
import type { ScoreSpeedBucket } from "../shared/score.js";
import { clampInteger, parseUserIds } from "./request.js";

export function parseMapsPageQuery(params: URLSearchParams): MapsPageQuery {
  const rawTab = params.get("tab");
  const tab = rawTab === "popular" || rawTab === "favourites" ? rawTab : "farmed";
  const rawKey = params.get("key");
  const key = rawKey === "4k" || rawKey === "7k" || rawKey === "other" ? rawKey : "all";
  const rawBeatmapSort = params.get("beatmapSort");
  const beatmapSort =
    rawBeatmapSort === "plays" ||
    rawBeatmapSort === "stars" ||
    rawBeatmapSort === "length"
      ? rawBeatmapSort
      : "players";
  const rawFarmedSort = params.get("farmedSort");
  const farmedSort =
    rawFarmedSort === "avg-pp" ||
    rawFarmedSort === "max-pp" ||
    rawFarmedSort === "stars" ||
    rawFarmedSort === "recent"
      ? rawFarmedSort
      : "players";
  const rawDir = params.get("dir");
  const dir = rawDir === "asc" ? "asc" : "desc";
  const rawStatus = params.get("status");
  const status = rawStatus === "ranked" || rawStatus === "loved" || rawStatus === "graveyard" || rawStatus === "other"
    ? rawStatus
    : "all";
  const rawMod = params.get("mod");
  const mod = rawMod === "dt" || rawMod === "ht" || rawMod === "nm" ? rawMod : "all";
  const page = clampInteger(params.get("page"), 0, 10_000, 0);
  const pageSize = clampInteger(params.get("pageSize"), 1, 48, 24);
  const rawPp = Number(params.get("pp") ?? 0);
  const pp = Number.isFinite(rawPp) && rawPp > 0
    ? Math.round(Math.min(Math.max(rawPp, 200), 1000) / 25) * 25
    : 0;

  return {
    tab,
    page,
    pageSize,
    key,
    beatmapSort,
    farmedSort,
    dir,
    status,
    pp,
    mod,
    q: (params.get("q") ?? "").trim().slice(0, 120),
  };
}

// Every list is validated against a closed vocabulary and every id list is
// capped, so a hand-written query string can't grow the draw's SQL. Garbage
// values are dropped rather than 400'd, like the sibling maps routes.
export function parseMapsRandomDrawQuery(params: URLSearchParams): MapsRandomDrawQuery {
  const idList = (key: string, max: number): number[] => parseUserIds(params.get(key)).slice(0, max);
  return {
    weight: params.get("weight") === "players" ? "players" : "favourites",
    count: clampInteger(params.get("count"), 0, MAPS_RANDOM_DRAW_MAX_COUNT, MAPS_RANDOM_DRAW_DEFAULT_COUNT),
    status: parseCsvSubset(params.get("status"), MAPS_RANDOM_STATUS_BUCKETS),
    statusExclude: parseCsvSubset(params.get("statusExclude"), MAPS_RANDOM_STATUS_BUCKETS),
    keys: parseCsvSubset(params.get("keys"), MAPS_RANDOM_KEY_BUCKETS),
    keysExclude: parseCsvSubset(params.get("keysExclude"), MAPS_RANDOM_KEY_BUCKETS),
    patterns: parseCsvSubset(params.get("patterns"), MAPS_RANDOM_PATTERN_NAMES),
    patternsExclude: parseCsvSubset(params.get("patternsExclude"), MAPS_RANDOM_PATTERN_NAMES),
    starMin: optionalBoundedNumber(params.get("starMin"), 0, MAPS_RANDOM_DRAW_STAR_MAX) ?? 0,
    starMax: optionalBoundedNumber(params.get("starMax"), 0, MAPS_RANDOM_DRAW_STAR_MAX) ?? 0,
    excludeUsers: idList("excludeUsers", MAPS_RANDOM_DRAW_EXCLUDE_USERS_MAX),
    excludeSets: idList("excludeSets", MAPS_RANDOM_DRAW_EXCLUDE_SETS_MAX),
    hideUsers: idList("hideUsers", MAPS_RANDOM_DRAW_HIDE_USERS_MAX),
  };
}

export function parseMapSearchQuery(params: URLSearchParams): MapSearchQuery {
  const rawSort = params.get("sort");
  const sort: MapSearchSort =
    rawSort === "stars" || rawSort === "bpm" || rawSort === "length" || rawSort === "playcount" || rawSort === "date" || rawSort === "relevance"
      ? rawSort
      : "playcount";
  const stars = parseSearchRange(params, "starMin", "starMax", 0, 20);
  const bpm = parseSearchRange(params, "bpmMin", "bpmMax", 0, 2000);
  const length = parseSearchRange(params, "lenMin", "lenMax", 0, 100_000);
  const dan = parseSearchRange(params, "danMin", "danMax", -2, 21);
  const rawCountry = (params.get("country") ?? "").trim().toUpperCase();
  const country = /^[A-Z]{2}$/.test(rawCountry) ? rawCountry : null;
  return {
    q: (params.get("q") ?? "").trim().slice(0, 120),
    keys: parseCsvSubset(params.get("keys"), ["4k", "7k", "other"]),
    keysExclude: parseCsvSubset(params.get("keysExclude"), ["4k", "7k", "other"]),
    statuses: parseCsvSubset(params.get("statuses"), ["ranked", "qualified", "loved", "graveyard", "other"]),
    statusesExclude: parseCsvSubset(params.get("statusesExclude"), ["ranked", "qualified", "loved", "graveyard", "other"]),
    patterns: parseCsvSubset(params.get("patterns"), [...MAP_SEARCH_PATTERNS, ...MAP_SEARCH_SUB_PATTERNS]),
    patternsExclude: parseCsvSubset(params.get("patternsExclude"), [...MAP_SEARCH_PATTERNS, ...MAP_SEARCH_SUB_PATTERNS]),
    starMin: stars.min,
    starMax: stars.max,
    bpmMin: bpm.min,
    bpmMax: bpm.max,
    lenMin: length.min,
    lenMax: length.max,
    danMin: dan.min,
    danMax: dan.max,
    country,
    sort,
    dir: params.get("dir") === "asc" ? "asc" : "desc",
    page: clampInteger(params.get("page"), 0, 10_000, 0),
    pageSize: clampInteger(params.get("pageSize"), 1, 48, 24),
  };
}

function parseCsvSubset(raw: string | null, allowed: string[]): string[] {
  if (!raw) return [];
  const allowedSet = new Set(allowed);
  return [...new Set(raw.toLowerCase().split(",").map((value) => value.trim()).filter((value) => allowedSet.has(value)))];
}

function parseSearchRange(params: URLSearchParams, minKey: string, maxKey: string, lo: number, hi: number): { min: number | null; max: number | null } {
  let min = optionalBoundedNumber(params.get(minKey), lo, hi);
  let max = optionalBoundedNumber(params.get(maxKey), lo, hi);
  if (min != null && max != null && min > max) [min, max] = [max, min];
  return { min, max };
}

function optionalBoundedNumber(raw: string | null, lo: number, hi: number): number | null {
  if (raw == null || raw.trim() === "") return null;
  const value = Number(raw);
  if (!Number.isFinite(value)) return null;
  return Math.max(lo, Math.min(hi, value));
}

export function parseMapsPlayersKind(raw: string | null): MapsPlayersKind | null {
  return raw === "farmed" || raw === "popular" || raw === "favourite" ? raw : null;
}

export function parseFarmHelperKeyMode(raw: string | null): FarmHelperKeyMode | undefined {
  return raw === "4k" || raw === "7k" || raw === "any" ? raw : undefined;
}

export function parseFarmHelperView(raw: string | null): FarmHelperView | undefined {
  return raw === "gain" || raw === "popular" ? raw : undefined;
}

export function parseFarmHelperSpeedBucket(raw: string | null): ScoreSpeedBucket | undefined {
  return raw === "ht" || raw === "normal" || raw === "dt" ? raw : undefined;
}

export function parseTopPlaysSnapshotQuery(params: URLSearchParams): TopPlaysSnapshotOptions {
  const rawSort = params.get("sort");
  const rawKeys = params.get("keys");
  return {
    sort: rawSort === "recent" || rawSort === "pp" || rawSort === "gain" ? rawSort : undefined,
    dir: params.get("dir") === "asc" ? "asc" : "desc",
    keys: rawKeys === "4k" || rawKeys === "other" ? rawKeys : "all",
    page: clampInteger(params.get("page"), 1, 10_000, 1),
    pageSize: clampInteger(params.get("pageSize") ?? params.get("limit"), 1, 200, 200),
    includePpGains: params.get("includePpGains") === "1",
    userIds: parseUserIds(params.get("userIds")),
  };
}

export function parseGlobalRankingsQuery(params: URLSearchParams): {
  page: number;
  pageSize: number;
  sort: GlobalRankingsSort;
  dir: "asc" | "desc";
  pool?: "packs";
  keys?: 4 | 7;
} {
  const rawSort = params.get("sort");
  const sort: GlobalRankingsSort =
    rawSort === "player" ||
    rawSort === "7d" ||
    rawSort === "cr7d" ||
    rawSort === "accuracy" ||
    rawSort === "playcount" ||
    rawSort === "pp" ||
    rawSort === "ss" ||
    rawSort === "s" ||
    rawSort === "a"
      ? rawSort
      : "rank";
  return {
    page: clampInteger(params.get("page"), 1, 10_000, 1),
    pageSize: clampInteger(params.get("pageSize") ?? params.get("limit"), 1, 50, 50),
    sort,
    dir: params.get("dir") === "asc" ? "asc" : "desc",
    // keys narrows the packs pool to one main keymode; it means nothing on
    // leaderboard reads, so it only parses alongside pool=packs.
    ...(params.get("pool") === "packs"
      ? {
          pool: "packs" as const,
          ...(params.get("keys") === "4"
            ? { keys: 4 as const }
            : params.get("keys") === "7"
              ? { keys: 7 as const }
              : {}),
        }
      : {}),
  };
}

// The skill and dan leaderboards. `keys` is the numeric keymode (the pack-pool
// convention on /api/snapshots/global-rankings), and the axis whitelist is the
// keymode's own published vocabulary, so a 4K skillset name cannot address a 7K
// board and vice versa.
export function parseSkillLeaderboardQuery(params: URLSearchParams): {
  keyCount: number;
  axis: string | null;
  page: number;
  pageSize: number;
} {
  const keyCount = clampInteger(params.get("keys"), 0, 20, 4);
  const axis = (params.get("axis") ?? "").trim();
  return {
    keyCount,
    axis: axis && isSkillLeaderboardKeyCount(keyCount) && isLeaderboardAxis(keyCount, axis) ? axis : null,
    page: clampInteger(params.get("page"), 1, 2_000, 1),
    pageSize: clampInteger(params.get("pageSize") ?? params.get("limit"), 1, SKILL_LEADERBOARD_MAX_PAGE_SIZE, SKILL_LEADERBOARD_MAX_PAGE_SIZE),
  };
}

export function parseDanLeaderboardQuery(params: URLSearchParams): {
  keyCount: number;
  side: DanSide;
  page: number;
  pageSize: number;
} {
  return {
    keyCount: clampInteger(params.get("keys"), 0, 20, 4),
    side: params.get("side") === "ln" ? "ln" : "rc",
    page: clampInteger(params.get("page"), 1, 2_000, 1),
    pageSize: clampInteger(params.get("pageSize") ?? params.get("limit"), 1, SKILL_LEADERBOARD_MAX_PAGE_SIZE, SKILL_LEADERBOARD_MAX_PAGE_SIZE),
  };
}

export function readMyDataTrackedQuery(params: URLSearchParams): MyDataTrackedFeedQuery {
  return {
    search: params.get("q"),
    key: params.get("key"),
    mods: params.get("mods"),
    archive: params.get("archive"),
    sort: params.get("sort"),
  };
}

export function readMyDataTopPlaysQuery(params: URLSearchParams): MyDataTopPlaysQuery {
  return {
    search: params.get("q"),
    key: params.get("key"),
    mods: params.get("mods"),
    sort: params.get("sort"),
  };
}

export function parseTrackerSnapshotFilters(params: URLSearchParams): TrackerSnapshotFilters {
  const score = params.get("scoreFilter");
  const grade = params.get("grade");
  const key = params.get("key");
  const miss = params.get("miss");
  return {
    score: score === "ranked" ? "ranked" : undefined,
    grade: grade === "SS" || grade === "S" || grade === "A" || grade === "B" ? grade : undefined,
    key: key === "4k" || key === "other" ? key : undefined,
    miss: miss === "fc" || miss === "fc_choke" ? miss : undefined,
  };
}

export function parseTrackerSnapshotSort(params: URLSearchParams): "recent" | "stars" {
  return params.get("sort") === "stars" ? "stars" : "recent";
}

export function parseTrackerSnapshotSortDirection(params: URLSearchParams): "asc" | "desc" {
  return params.get("sortDirection") === "asc" ? "asc" : "desc";
}
