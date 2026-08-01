import { createFileRoute, stripSearchParams, useNavigate } from "@tanstack/react-router";
import { useState, useEffect, useLayoutEffect, useMemo, useRef, useCallback, useDeferredValue } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import { Dices } from "lucide-react";
import { getBeatmapFile } from "../lib/osu";
import { LiveBackendRequired } from "../components/LiveDataEmptyState";
import { getCountryName, isGlobalScope } from "../lib/country";
import { formatNumber, formatDuration, formatTimeAgo } from "../lib/format";
import { MANIA_PATTERN_LABELS } from "../lib/mania-patterns";
import { PageHeader } from "../components/layout/PageHeader";
import { Avatar } from "../components/ui/Avatar";
import { OsuLogo } from "../components/ui/OsuLogo";
import { Skeleton } from "../components/ui/LoadingSkeleton";
import { ModGlyph } from "../components/maps/ModGlyph";
import { MapSearchSection, type MapSearchUiState } from "../components/maps/MapSearchSection";
import {
  DEFAULT_SEARCH_SORT,
  SEARCH_SORT_VALUES,
  isPersistableSearchSort,
  readSearchSortPreference,
  writeSearchSortPreference,
} from "../components/maps/searchSortPreference";
import {
  Chip,
  ChipGroup,
  DirButton,
  SortSelect,
  StatusChip,
  STATUS_COLOR,
  TriStatePill,
  type SortOption,
} from "../components/maps/FilterChips";
import { StarRangePill } from "../components/maps/StarRangePill";
import { MapCollectionsSection } from "../components/maps/MapCollectionsSection";
import { MapDetailModal } from "../components/maps/MapDetailModal";
import { PATTERN_COLOR, StarRatingBadge } from "../components/maps/SearchCard";
import { ModBadge } from "../components/ui/ModBadge";
import { Pagination } from "../components/ui/Pagination";
import type {
  MapsAggregatedBeatmap,
  MapsAggregatedFavourite,
  MapsFarmedEntry,
  MapsFarmedPlayer,
  MapsFavouriteBeatmapset,
  MapsPlayerEntry,
  ReplayFrame,
} from "../lib/types";
import type { ManiaBeatmap, ManiaNote, ManiaScrollVelocity } from "../lib/beatmap-parser";
import { useHasHydrated, useHiddenUserIds, useSelectedCountry } from "../store";
import { pageSeo, mapsOgImagePath } from "../lib/seo";
import { parseCountrySearchParam, withSearchParams } from "../lib/country-search";
import { getBeatmapAudioUrl, getPreviewAudioProxyUrl } from "../lib/audio-url";
import { getPreviewAnalyser, releasePreviewAnalyser } from "../lib/preview-analyser";
import {
  RANDOM_REPLAY_PREVIEW_MS,
  buildAutoplayFrames,
  getBracketBpmBase,
  getChartPreviewPlaybackPlan,
  getPreviewInitialCombo,
  getPreviewNotes,
  getPreviewScrollVelocities,
  getSetPreviewReferenceBeatmap,
  isLikelyBracketBpmVariantSet,
  isLikelyRateVariantSet,
  isLikelyTimedRateVariantSet,
  parseBracketBpm,
  parseDifficultyRate,
  parseSelectedDifficultyRate,
  resolveInitialChartPreviewAudioMode,
  shouldUseSetPreviewForReplayAudio,
} from "../lib/chart-preview";
import { REPLAY_SCROLL_SPEED_CHANGE_EVENT, readReplayScrollSpeed } from "../lib/replay-scroll-speed";
import { REPLAY_SKIN_SETTINGS_CHANGE_EVENT, readReplaySkinSettings } from "../lib/replay-skin";
import type { ReplaySkinSettings } from "../lib/replay-skin";
import { useAuth } from "../lib/auth-context";
import {
  fetchLiveMapSearchEntry,
  fetchLiveMapsPageSnapshot,
  fetchLiveMapsPlayersSnapshot,
  fetchLiveMapsProgress,
  fetchLiveMapsRandomDraw,
  isLiveBackendConfigured,
  openLiveEventSource,
  runLiveBackendAdminAction,
} from "../lib/live-backend";
import { LIVE_MAPS_PLAYERS_PAGE_SIZE, RANDOM_DRAW_BATCH_SIZE } from "../lib/live-backend";
import type { LiveMapSearchEntry, LiveMapsBrowseTab, LiveMapsDetailsPlayer, LiveMapsPageValue, LiveMapsPlayersKind, LiveMapsRandomDrawSnapshot, LiveMapsRandomDrawValue, LiveMapsRandomPick, LiveMapsRefreshProgress } from "../lib/live-backend";
import { CountryWarming } from "../components/CountryWarming";
import { useCountryWarming } from "../lib/use-country-warming";
import { parseCachedManiaBeatmap } from "../lib/parsed-beatmap-cache";
import {
  cycleTriStateCsv,
  getTriStateMode,
  parseTriStateCsv,
  reverseCycleTriStateCsv,
  serializeTriStateCsv,
  triStateActive,
} from "../lib/maps-random-filter";
import {
  RANDOM_KEY_OPTIONS,
  RANDOM_PATTERN_OPTIONS,
  RANDOM_STATUS_OPTIONS,
  buildRandomDrawFilters,
  buildRandomDrawParams,
} from "../lib/maps-random-draw-params";
import type { RandomPattern, RandomWeight } from "../lib/maps-random-draw-params";
import { MapsRandomDrawController } from "../lib/maps-random-draw-state";
import type { RandomDrawEvent } from "../lib/maps-random-draw-state";
import { useWindowActive } from "../lib/window-activity";

// ── Types ──────────────────────────────────────────────────────────────────

type Tab = "farmed" | "popular" | "favourites" | "random" | "search" | "collections";
type KeyFilter = "all" | "4k" | "7k" | "other";
type BeatmapSort = "plays" | "players" | "stars" | "length";
type FarmedSort = "players" | "avg-pp" | "max-pp" | "stars" | "recent";
type SortDirection = "desc" | "asc";
type StatusFilter = "all" | "ranked" | "loved" | "graveyard" | "other";
type PpFilter = number;
type ModFilter = "all" | "dt" | "ht" | "nm";

// Sort vocabularies for the browse tabs' "Sort by" row and mobile dropdown.
const FARMED_SORT_OPTIONS: SortOption[] = [
  { id: "players", label: "Players" },
  { id: "avg-pp", label: "Avg PP" },
  { id: "max-pp", label: "Max PP" },
  { id: "stars", label: "Stars" },
  { id: "recent", label: "Recent plays" },
];
const POPULAR_SORT_OPTIONS: SortOption[] = [
  { id: "players", label: "Players" },
  { id: "plays", label: "Plays" },
  { id: "stars", label: "Stars" },
  { id: "length", label: "Length" },
];

type MapsSearch = {
  tab: Tab;
  page: number;
  key: KeyFilter;
  beatmapSort: BeatmapSort;
  farmedSort: FarmedSort;
  dir: SortDirection;
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
  // Global catalog Search tab (s-prefixed so they never collide with the
  // country-scoped tabs or the r-prefixed random fields).
  sQ: string;
  sKeys: string;
  sStatuses: string;
  sStarMin: number;
  sStarMax: number;
  sBpmMin: number;
  sBpmMax: number;
  sLenMin: number;
  sLenMax: number;
  sDanMin: number | null;
  sDanMax: number | null;
  sPatterns: string;
  sCountryOnly: boolean;
  sSort: string;
  sDir: string;
  // Collections tab: selected pack id ("" = browse grid).
  col: string;
  // Shared map link: beatmap id whose detail modal auto-opens (0 = none).
  map: number;
  country: string | undefined;
};

const PAGE_SIZE = 24;
const VISIBLE_AVATARS = 4;
// Keep in sync with the live backend (FARMED_DOMINANT_MOD_SHARE): a speed mod is
// dominant when more than this share of the farming roster used it.
const FARMED_DOMINANT_MOD_SHARE = 0.4;
const RANDOM_PICK_SETTINGS_STORAGE_KEY = "mania-hub-maps-random-pick-settings-v1";
const SEARCH_URL_DEBOUNCE_MS = 250;
const LIVE_MAPS_PAGE_CACHE_MAX_ENTRIES = 48;

function beatmapStatusBadgeClass(status: string): string {
  const normalized = status.toLowerCase();
  const colorClass =
    normalized === "ranked" || normalized === "approved"
      ? "bg-[#6cf27f]"
      : normalized === "loved"
        ? "bg-[#f26fa6]"
        : normalized === "graveyard"
          ? "bg-[#b3b3b3]"
          : "bg-[#ffd36b]";

  return [
    "inline-flex shrink-0 items-center justify-center rounded-full",
    "px-2.5 py-1 text-[10px] font-extrabold uppercase leading-none text-black",
    colorClass,
  ].join(" ");
}

function BeatmapStatusBadge({ status, className = "" }: { status: string; className?: string }) {
  return (
    <span className={`${beatmapStatusBadgeClass(status)} ${className}`}>
      {status}
    </span>
  );
}

const DEFAULT_MAPS_SEARCH: MapsSearch = {
  // Search leads the view bar and is the landing tab; the country lenses follow.
  tab: "search",
  page: 0,
  key: "all",
  beatmapSort: "players",
  farmedSort: "players",
  dir: "desc",
  status: "all",
  pp: 0,
  mod: "all",
  q: "",
  rStatus: "",
  rKey: "",
  rPattern: "",
  rStars: 0,
  rStarsMax: 0,
  rWeight: "favourites",
  rAvoidRepeats: false,
  sQ: "",
  sKeys: "",
  sStatuses: "",
  sStarMin: 0,
  sStarMax: 0,
  sBpmMin: 0,
  sBpmMax: 0,
  sLenMin: 0,
  sLenMax: 0,
  sDanMin: null,
  sDanMax: null,
  sPatterns: "",
  sCountryOnly: false,
  sSort: DEFAULT_SEARCH_SORT.sort,
  sDir: DEFAULT_SEARCH_SORT.dir,
  col: "",
  map: 0,
  country: undefined,
};

const SEARCH_KEY_VALUES = ["4k", "7k", "other"];
const SEARCH_STATUS_VALUES = ["ranked", "qualified", "loved", "graveyard", "other"];
const SEARCH_PATTERN_VALUES = [
  "jack", "stream", "jumpstream", "handstream", "stamina", "chordjack", "tech", "ln",
  // subfamilies (matched against detected-pattern tags, not dominance)
  "speedjack", "handjack", "dumpstream", "quadstream", "chordstream", "delay", "bracket",
  "lngeneral", "lnrelease", "lninverse", "lntech",
];
// SEARCH_SORT_VALUES lives in components/maps/searchSortPreference.ts.

// Search range fields use 0 as "unset"; clamp anything else into [min, max].
function clampSearchNumber(raw: unknown, min: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(max, Math.max(min, n));
}

// Dan levels use null as "unset" because level 0 is a real dan (7K 0th).
function clampDanLevel(raw: unknown): number | null {
  if (raw == null) return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return Math.round(Math.min(20, Math.max(0, n)));
}

// Search facets use Random's signed CSV convention: `value` includes and
// `-value` excludes. Existing unsigned links remain valid includes. When a
// hand-written URL repeats a value, its final occurrence wins.
function sanitizeSearchTriStateCsv(raw: unknown, allowed: string[]): string {
  if (typeof raw !== "string" || !raw) return "";
  const allowedSet = new Set(allowed);
  const modes = new Map<string, "include" | "exclude">();
  for (const part of raw.toLowerCase().split(",")) {
    const trimmed = part.trim();
    const exclude = trimmed.startsWith("-");
    const value = exclude ? trimmed.slice(1) : trimmed;
    if (!allowedSet.has(value)) continue;
    modes.delete(value);
    modes.set(value, exclude ? "exclude" : "include");
  }
  return [...modes].map(([value, mode]) => mode === "exclude" ? `-${value}` : value).join(",");
}

type RandomPickSettings = Pick<MapsSearch, "rWeight" | "rAvoidRepeats">;
type LiveMapsPageState = LiveMapsPageValue & { requestKey: string };
const liveMapsPageSessionCache = new Map<string, LiveMapsPageState>();
const liveMapsPageTotalSessionCache = new Map<string, number>();

// Read and JSON-parse a localStorage object, returning null on miss, parse
// error, or non-object so each caller validates its own fields against a plain
// record. Shared by the small per-feature preference readers below.
function readStoredRecord(key: string): Record<string, unknown> | null {
  if (typeof window === "undefined") return null;

  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;

    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;

    return parsed as Record<string, unknown>;
  } catch (error) {
    console.warn(`[maps] failed to read "${key}"`, error);
    return null;
  }
}

function readRandomPickSettings(): Partial<RandomPickSettings> {
  const parsed = readStoredRecord(RANDOM_PICK_SETTINGS_STORAGE_KEY);
  if (!parsed) return {};

  const settings: Partial<RandomPickSettings> = {};
  const { rWeight, rAvoidRepeats } = parsed;
  if (rWeight === "players" || rWeight === "favourites") settings.rWeight = rWeight;
  if (typeof rAvoidRepeats === "boolean") settings.rAvoidRepeats = rAvoidRepeats;
  return settings;
}

function writeRandomPickSettings(patch: Partial<RandomPickSettings>): void {
  if (typeof window === "undefined") return;

  try {
    localStorage.setItem(
      RANDOM_PICK_SETTINGS_STORAGE_KEY,
      JSON.stringify({
        ...readRandomPickSettings(),
        ...patch,
      }),
    );
  } catch (error) {
    console.warn("[maps] failed to write random pick settings", error);
  }
}

function formatLiveMapsProgress(progress: LiveMapsRefreshProgress): string {
  const percent = Math.max(0, Math.min(100, Math.round(progress.percent)));
  if (progress.status === "queued") return "Loading maps...";
  if (progress.status === "failed") return "Maps build failed.";
  if (progress.stage === "done" || progress.status === "done") return "Maps ready.";
  const message = progress.message || (progress.stage === "persisting" ? "Saving maps..." : "Building maps...");
  return `${message} (${percent}%)`;
}

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
  tiebreaker: "Tournament",
};

// The search tab's pattern palette, extended for the two tags that aren't
// chart patterns there (SV borrows handstream's unused yellow, Tournament
// gets the silver the pattern chips fall back to).
const RANDOM_PATTERN_CHIP_COLOR: Record<RandomPattern, string> = {
  jack: PATTERN_COLOR.jack,
  chordjack: PATTERN_COLOR.chordjack,
  stream: PATTERN_COLOR.stream,
  jumpstream: PATTERN_COLOR.jumpstream,
  stamina: PATTERN_COLOR.stamina,
  tech: PATTERN_COLOR.tech,
  ln: PATTERN_COLOR.ln,
  sv: "#f3c24a",
  tiebreaker: "#cfcfe6",
};

// ── Helpers ────────────────────────────────────────────────────────────────

function parseKeyCount(version: string): number | null {
  const match = version.match(/\b(\d)K\b/i);
  return match ? parseInt(match[1]) : null;
}

function getDefaultRandomBeatmapId(beatmaps: NonNullable<MapsFavouriteBeatmapset["maniaBeatmaps"]>): number | null {
  if (!beatmaps.length) return null;
  const meaningfulBeatmaps = beatmaps.filter((beatmap) => beatmap.difficultyRating >= 0.5);
  if (isLikelyBracketBpmVariantSet(meaningfulBeatmaps)) {
    const baseBpm = getBracketBpmBase(meaningfulBeatmaps);
    const base = meaningfulBeatmaps.find((beatmap) => parseBracketBpm(beatmap.version) === baseBpm);
    if (base) return base.id;
  }
  if (isLikelyRateVariantSet(meaningfulBeatmaps)) {
    const base = meaningfulBeatmaps.find((beatmap) => parseDifficultyRate(beatmap.version) === 1);
    if (base) return base.id;
    const lowest = [...meaningfulBeatmaps].sort((a, b) => a.difficultyRating - b.difficultyRating)[0];
    return lowest?.id ?? beatmaps.at(-1)?.id ?? null;
  }
  return beatmaps[0]?.id ?? null;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function getBeatmapFileWithRetry(beatmapId: number, beatmapsetId?: number) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const result = await getBeatmapFile({ data: { beatmapId, beatmapsetId } });
      if (!result.content.trim()) throw new Error("Empty beatmap file");
      return result;
    } catch (error) {
      lastError = error;
      if (attempt < 2) await wait(250 * (attempt + 1));
    }
  }
  throw lastError;
}

function setAudioPreservesPitch(audio: HTMLAudioElement, preservesPitch: boolean): void {
  const pitchAudio = audio as HTMLAudioElement & {
    mozPreservesPitch?: boolean;
    preservesPitch?: boolean;
    webkitPreservesPitch?: boolean;
  };
  pitchAudio.preservesPitch = preservesPitch;
  pitchAudio.mozPreservesPitch = preservesPitch;
  pitchAudio.webkitPreservesPitch = preservesPitch;
}

function resetAudioElement(audio: HTMLAudioElement | null, unload = false): void {
  if (!audio) return;
  audio.pause();
  audio.playbackRate = 1;
  setAudioPreservesPitch(audio, true);
  try {
    audio.currentTime = 0;
  } catch {
    // Some mobile browsers reject seeks while the element is still choosing a source.
  }
  if (unload) {
    audio.removeAttribute("src");
    try {
      audio.load();
    } catch {
      // Best-effort cleanup; pausing above is the important part.
    }
  }
}

const AUDIO_METADATA_TIMEOUT_MS = 1500;
const SELECTED_AUDIO_METADATA_TIMEOUT_MS = 60_000;
const SELECTED_AUDIO_SEEK_SETTLE_TIMEOUT_MS = 5000;

function waitForAudioMetadata(
  audio: HTMLAudioElement,
  timeoutMs = AUDIO_METADATA_TIMEOUT_MS,
  requireMetadata = false,
): Promise<void> {
  if (audio.readyState >= HTMLMediaElement.HAVE_METADATA) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let timeoutId: number | null = null;
    const done = (loaded: boolean) => {
      if (timeoutId) window.clearTimeout(timeoutId);
      audio.removeEventListener("loadedmetadata", onLoadedMetadata);
      audio.removeEventListener("error", onError);
      if (loaded || !requireMetadata) {
        resolve();
      } else {
        reject(new Error("Audio metadata did not load"));
      }
    };
    const onLoadedMetadata = () => done(true);
    const onError = () => done(false);
    const onTimeout = () => {
      done(audio.readyState >= HTMLMediaElement.HAVE_METADATA);
    };
    audio.addEventListener("loadedmetadata", onLoadedMetadata);
    audio.addEventListener("error", onError);
    timeoutId = window.setTimeout(onTimeout, timeoutMs);
  });
}

const AUDIO_SEEK_TOLERANCE_SECONDS = 0.25;
const AUDIO_SEEK_SETTLE_TIMEOUT_MS = 1200;

function waitForAudioSeekSettle(
  audio: HTMLAudioElement,
  targetSeconds: number,
  timeoutMs = AUDIO_SEEK_SETTLE_TIMEOUT_MS,
): Promise<void> {
  return new Promise((resolve) => {
    let rafId: number | null = null;
    let timeoutId: number | null = null;
    let settledFrames = 0;
    const isCloseToTarget = () => Math.abs(audio.currentTime - targetSeconds) <= AUDIO_SEEK_TOLERANCE_SECONDS;

    const cleanup = () => {
      if (rafId != null) window.cancelAnimationFrame(rafId);
      if (timeoutId != null) window.clearTimeout(timeoutId);
      audio.removeEventListener("seeked", scheduleCheck);
      audio.removeEventListener("canplay", scheduleCheck);
      audio.removeEventListener("loadeddata", scheduleCheck);
      audio.removeEventListener("timeupdate", scheduleCheck);
      audio.removeEventListener("error", done);
    };
    const done = () => {
      cleanup();
      resolve();
    };
    const check = () => {
      rafId = null;
      if (audio.error) {
        done();
        return;
      }
      if (!audio.seeking && isCloseToTarget()) {
        settledFrames += 1;
        if (settledFrames >= 2) {
          done();
          return;
        }
      } else {
        settledFrames = 0;
      }
      scheduleCheck();
    };
    function scheduleCheck() {
      if (rafId == null) rafId = window.requestAnimationFrame(check);
    }

    audio.addEventListener("seeked", scheduleCheck);
    audio.addEventListener("canplay", scheduleCheck);
    audio.addEventListener("loadeddata", scheduleCheck);
    audio.addEventListener("timeupdate", scheduleCheck);
    audio.addEventListener("error", done);
    timeoutId = window.setTimeout(done, timeoutMs);
    scheduleCheck();
  });
}

async function seekAudioElement(
  audio: HTMLAudioElement,
  seconds: number,
  options?: { metadataTimeoutMs?: number; requireMetadata?: boolean; seekSettleTimeoutMs?: number },
): Promise<void> {
  const targetSeconds = Math.max(0, seconds);
  await waitForAudioMetadata(audio, options?.metadataTimeoutMs, options?.requireMetadata);
  try {
    audio.currentTime = targetSeconds;
  } catch {
    return;
  }
  await waitForAudioSeekSettle(audio, targetSeconds, options?.seekSettleTimeoutMs);
}

// ── Route ──────────────────────────────────────────────────────────────────

export const Route = createFileRoute("/maps")({
  head: ({ match }) => {
    // Search + collections are global catalog views with their own OG
    // cards; the country-scoped lenses share the country mosaic below.
    const tab = match.search.tab;
    if (tab === "search" || tab === "collections") {
      const isSearch = tab === "search";
      return pageSeo({
        title: isSearch ? "Map search" : "Map collections",
        description: isSearch
          ? "Search every ranked osu!mania map by title, keymode, stars, and status."
          : "Browse rotating osu!mania map packs grouped by pattern, dan estimate, and MSD.",
        // Search is the default tab and its default search param is stripped
        // from the visible URL, so keep the canonical aligned with /maps.
        path: isSearch ? "/maps" : withSearchParams("/maps", { tab }),
        origin: match.context.origin,
        imageKind: isSearch ? "maps-search" : "maps-collections",
      });
    }
    const country = match.search.country;
    const countryName = country ? getCountryName(country) : null;
    return pageSeo({
      title: countryName ? `Beatmaps played in ${countryName}` : "Beatmaps played by your country",
      description: countryName
        ? `osu!mania maps played by top players in ${countryName}.`
        : "osu!mania maps played by top country players.",
      path: withSearchParams("/maps", { country }),
      origin: match.context.origin,
      image: country ? mapsOgImagePath(country) : undefined,
    });
  },
  search: {
    middlewares: [stripSearchParams(DEFAULT_MAPS_SEARCH)],
  },
  validateSearch: (search: Record<string, unknown>): MapsSearch => ({
    tab:
      search.tab === "farmed" ||
      search.tab === "popular" ||
      search.tab === "favourites" ||
      search.tab === "random" ||
      search.tab === "search" ||
      search.tab === "collections"
        ? search.tab
        : DEFAULT_MAPS_SEARCH.tab,
    page: Math.max(0, Math.floor(Number(search.page) || DEFAULT_MAPS_SEARCH.page)),
    key: search.key === "4k" || search.key === "7k" || search.key === "other" ? search.key : DEFAULT_MAPS_SEARCH.key,
    beatmapSort: search.beatmapSort === "players" || search.beatmapSort === "plays" || search.beatmapSort === "stars" || search.beatmapSort === "length" ? search.beatmapSort : DEFAULT_MAPS_SEARCH.beatmapSort,
    farmedSort:
      search.farmedSort === "players" ||
      search.farmedSort === "avg-pp" ||
      search.farmedSort === "max-pp" ||
      search.farmedSort === "stars" ||
      search.farmedSort === "recent"
        ? search.farmedSort
        : DEFAULT_MAPS_SEARCH.farmedSort,
    dir: search.dir === "asc" || search.dir === "desc" ? search.dir : DEFAULT_MAPS_SEARCH.dir,
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
    rWeight: search.rWeight === "players" || search.rWeight === "favourites" ? search.rWeight : DEFAULT_MAPS_SEARCH.rWeight,
    rAvoidRepeats: typeof search.rAvoidRepeats === "boolean" ? search.rAvoidRepeats : DEFAULT_MAPS_SEARCH.rAvoidRepeats,
    sQ: typeof search.sQ === "string" ? search.sQ.slice(0, 120) : DEFAULT_MAPS_SEARCH.sQ,
    sKeys: sanitizeSearchTriStateCsv(search.sKeys, SEARCH_KEY_VALUES),
    sStatuses: sanitizeSearchTriStateCsv(search.sStatuses, SEARCH_STATUS_VALUES),
    sStarMin: clampSearchNumber(search.sStarMin, 0, 20),
    sStarMax: clampSearchNumber(search.sStarMax, 0, 20),
    sBpmMin: clampSearchNumber(search.sBpmMin, 0, 2000),
    sBpmMax: clampSearchNumber(search.sBpmMax, 0, 2000),
    sLenMin: clampSearchNumber(search.sLenMin, 0, 100000),
    sLenMax: clampSearchNumber(search.sLenMax, 0, 100000),
    sDanMin: clampDanLevel(search.sDanMin),
    sDanMax: clampDanLevel(search.sDanMax),
    sPatterns: sanitizeSearchTriStateCsv(search.sPatterns, SEARCH_PATTERN_VALUES),
    sCountryOnly: false,
    sSort: SEARCH_SORT_VALUES.includes(String(search.sSort)) ? String(search.sSort) : DEFAULT_MAPS_SEARCH.sSort,
    sDir: search.sDir === "asc" ? "asc" : DEFAULT_MAPS_SEARCH.sDir,
    col: typeof search.col === "string" ? search.col.slice(0, 80) : DEFAULT_MAPS_SEARCH.col,
    map: Math.max(0, Math.floor(Number(search.map) || 0)),
    country: parseCountrySearchParam(search.country),
  }),
  component: MapsPage,
});

function MapsPage() {
  const navigate = useNavigate();
  const mapsSearch = Route.useSearch();
  const mapsSearchRef = useRef(mapsSearch);
  mapsSearchRef.current = mapsSearch;
  const auth = useAuth();
  const fallbackCountry = useSelectedCountry();
  const selectedCountry = mapsSearch.country ?? fallbackCountry;
  const hiddenUserIds = useHiddenUserIds();

  const [loadingMaps, setLoadingMaps] = useState(true);
  const [rebuilding, setRebuilding] = useState(false);
  const [liveMapsRefreshing, setLiveMapsRefreshing] = useState(false);
  const [liveMapsProgress, setLiveMapsProgress] = useState<LiveMapsRefreshProgress | null>(null);
  const [liveMapsPage, setLiveMapsPage] = useState<LiveMapsPageState | null>(null);
  const liveMapsPageCacheRef = useRef<Map<string, LiveMapsPageState>>(liveMapsPageSessionCache);
  const liveMapsPageTotalCacheRef = useRef<Map<string, number>>(liveMapsPageTotalSessionCache);
  // True while the server is building this country's maps for the very
  // first time (no snapshot has ever existed). Distinguishes a cold first build
  // from a quick refresh of already-cached maps.
  const [mapsFirstBuild, setMapsFirstBuild] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detailsOpen, setDetailsOpen] = useState<MapDetails | null>(null);
  const tab = mapsSearch.tab;
  // Search + Collections are global catalog views, not country-scoped lenses.
  const isGlobalCatalogTab = tab === "search" || tab === "collections";
  const page = mapsSearch.page;
  const keyFilter = mapsSearch.key;
  const beatmapSort = mapsSearch.beatmapSort;
  const farmedSort = mapsSearch.farmedSort;
  const sortDir = mapsSearch.dir;
  const statusFilter = mapsSearch.status;
  const ppFilter = mapsSearch.pp;
  const modFilter = mapsSearch.mod;
  const routeSearchQuery = mapsSearch.q;
  const [searchInput, setSearchInput] = useState(routeSearchQuery);
  const searchQuery = useDeferredValue(searchInput);
  const pendingSearchQueryRef = useRef<string | null>(null);
  const rStatusRaw = mapsSearch.rStatus;
  const rKeyRaw = mapsSearch.rKey;
  const rPatternRaw = mapsSearch.rPattern;
  const rStars = mapsSearch.rStars;
  const rStarsMax = mapsSearch.rStarsMax;
  const rWeight = mapsSearch.rWeight;
  const rAvoidRepeats = mapsSearch.rAvoidRepeats;
  const canUseAdminFeatures = auth.canUseAdminFeatures;
  const liveBackendEnabled = isLiveBackendConfigured();
  const windowActive = useWindowActive();
  // Global catalog tabs must not activate/warm a country: passing GLOBAL makes
  // the hook short-circuit (no activateLiveCountryOnce side effect).
  const { warming } = useCountryWarming(isGlobalCatalogTab ? "GLOBAL" : selectedCountry);
  const updateMapsSearch = useCallback((patch: Partial<MapsSearch>) => {
    const current = mapsSearchRef.current;
    const nextSearch = { ...current, ...patch };
    const changed = (Object.keys(patch) as Array<keyof MapsSearch>).some((key) => current[key] !== nextSearch[key]);
    if (!changed) return;

    navigate({
      to: "/maps",
      search: nextSearch,
      replace: true,
      resetScroll: false,
    });
  }, [navigate]);
  // Shared map link (?map=<beatmapId>): fetch that map's catalog entry and
  // auto-open the detail modal on top of whatever tab is showing. Opening a
  // map by clicking a card never touches the URL; only this param does.
  const sharedMapId = mapsSearch.map;
  const [sharedMapEntry, setSharedMapEntry] = useState<LiveMapSearchEntry | null>(null);
  useEffect(() => {
    if (!sharedMapId || !liveBackendEnabled) {
      setSharedMapEntry(null);
      return;
    }
    let cancelled = false;
    void fetchLiveMapSearchEntry(sharedMapId).then((entry) => {
      if (!cancelled) setSharedMapEntry(entry);
    });
    return () => {
      cancelled = true;
    };
  }, [sharedMapId, liveBackendEnabled]);

  const randomStatus = useMemo(() => parseTriStateCsv(rStatusRaw, RANDOM_STATUS_OPTIONS), [rStatusRaw]);
  const randomKey = useMemo(() => parseTriStateCsv(rKeyRaw, RANDOM_KEY_OPTIONS), [rKeyRaw]);
  const randomPattern = useMemo(() => parseTriStateCsv(rPatternRaw, RANDOM_PATTERN_OPTIONS), [rPatternRaw]);
  const totalRandomActive = triStateActive(randomStatus) + triStateActive(randomKey) + triStateActive(randomPattern) + (rStars > 0 || rStarsMax > 0 ? 1 : 0);
  const countryName = getCountryName(selectedCountry);
  // Header title tracks the active lens; search/collections keep "Mania maps".
  const scopeSuffix = isGlobalScope(selectedCountry) ? "globally" : `in ${countryName}`;
  const lensTitle =
    tab === "popular"
      ? `Most played ${scopeSuffix}`
      : tab === "favourites"
        ? `Favourites ${scopeSuffix}`
        : tab === "random"
          ? `Random picks ${scopeSuffix}`
          : `Most farmed ${scopeSuffix}`;
  const liveMapsBrowseTab = tab === "random" || isGlobalCatalogTab ? null : (tab as LiveMapsBrowseTab);
  const liveMapsPageParams = useMemo(() => liveMapsBrowseTab ? {
    tab: liveMapsBrowseTab,
    page,
    pageSize: PAGE_SIZE,
    key: keyFilter,
    beatmapSort,
    farmedSort,
    dir: sortDir,
    status: statusFilter,
    pp: ppFilter,
    mod: modFilter,
    q: routeSearchQuery,
  } : null, [liveMapsBrowseTab, page, keyFilter, beatmapSort, farmedSort, sortDir, statusFilter, ppFilter, modFilter, routeSearchQuery]);
  const liveMapsPageRequestKey = useMemo(
    () => liveMapsPageParams ? JSON.stringify({ country: selectedCountry, ...liveMapsPageParams }) : null,
    [liveMapsPageParams, selectedCountry],
  );
  const liveMapsPageScopeKey = useMemo(() => {
    if (!liveMapsPageParams) return null;
    return JSON.stringify({
      country: selectedCountry,
      tab: liveMapsPageParams.tab,
      pageSize: liveMapsPageParams.pageSize,
      key: liveMapsPageParams.key,
      beatmapSort: liveMapsPageParams.beatmapSort,
      farmedSort: liveMapsPageParams.farmedSort,
      dir: liveMapsPageParams.dir,
      status: liveMapsPageParams.status,
      pp: liveMapsPageParams.pp,
      mod: liveMapsPageParams.mod,
      q: liveMapsPageParams.q,
    });
  }, [liveMapsPageParams, selectedCountry]);
  const cachedLiveMapsPage = liveMapsPageRequestKey
    ? liveMapsPageCacheRef.current.get(liveMapsPageRequestKey) ?? null
    : null;
  const currentLiveMapsPage =
    liveMapsPageRequestKey && liveMapsPage?.requestKey === liveMapsPageRequestKey
      ? liveMapsPage
      : cachedLiveMapsPage;
  const knownLiveMapsTotal =
    liveBackendEnabled && liveMapsPageScopeKey
      ? currentLiveMapsPage?.total ?? liveMapsPageTotalCacheRef.current.get(liveMapsPageScopeKey) ?? 0
      : 0;
  const liveBackendPaged = liveBackendEnabled && !!liveMapsPageParams;
  const liveMapsPagePending = liveBackendPaged && !currentLiveMapsPage;
  const rememberLiveMapsPage = useCallback((pageState: LiveMapsPageState) => {
    const cache = liveMapsPageCacheRef.current;
    cache.delete(pageState.requestKey);
    cache.set(pageState.requestKey, pageState);
    while (cache.size > LIVE_MAPS_PAGE_CACHE_MAX_ENTRIES) {
      const oldestKey = cache.keys().next().value;
      if (oldestKey === undefined) break;
      cache.delete(oldestKey);
    }
    setLiveMapsPage(pageState);
  }, []);

  useEffect(() => {
    if (!liveMapsPageScopeKey || !currentLiveMapsPage) return;
    liveMapsPageTotalCacheRef.current.set(liveMapsPageScopeKey, currentLiveMapsPage.total);
  }, [currentLiveMapsPage, liveMapsPageScopeKey]);

  useEffect(() => {
    if (routeSearchQuery === pendingSearchQueryRef.current) {
      pendingSearchQueryRef.current = null;
      return;
    }
    setSearchInput(routeSearchQuery);
  }, [routeSearchQuery]);

  useEffect(() => {
    if (searchInput === routeSearchQuery) return;
    const timer = window.setTimeout(() => {
      pendingSearchQueryRef.current = searchInput;
      updateMapsSearch({ q: searchInput, page: 0 });
    }, SEARCH_URL_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [routeSearchQuery, searchInput, updateMapsSearch]);

  useEffect(() => {
    setLoadingMaps(false);
    setError(null);
    setLiveMapsRefreshing(false);
    setLiveMapsProgress(null);
    setLiveMapsPage(null);
  }, [selectedCountry, liveBackendEnabled]);

  useEffect(() => {
    if (!liveBackendEnabled) return;
    if (!liveMapsPageParams || !liveMapsPageRequestKey) return;

    const cachedPage = liveMapsPageCacheRef.current.get(liveMapsPageRequestKey) ?? null;
    // An unfocused tab defers refreshes, but the initial fill still runs so a
    // page opened in the background doesn't sit on skeletons until focus.
    if (!windowActive && cachedPage) {
      setLoadingMaps(false);
      return;
    }

    setMapsFirstBuild(false);
    setLiveMapsRefreshing(false);
    setLiveMapsProgress(null);
    let cancelled = false;
    setLoadingMaps(!cachedPage);
    let pollTimer: ReturnType<typeof setTimeout> | null = null;

    const loadPage = () => {
      fetchLiveMapsPageSnapshot(selectedCountry, liveMapsPageParams)
        .then((snapshot) => {
          if (cancelled) return;
          setLiveMapsRefreshing(snapshot.isStale || snapshot.refreshQueued);
          setLiveMapsProgress(snapshot.progress ?? null);
          if (snapshot.value) {
            rememberLiveMapsPage({ ...snapshot.value, requestKey: liveMapsPageRequestKey });
            setLoadingMaps(false);
            setMapsFirstBuild(false);
            setError(null);
          } else if (!cachedPage) {
            setLiveMapsPage(null);
            setLoadingMaps(true);
            setMapsFirstBuild(snapshot.generatedAt == null);
          }
          if (!cancelled && !snapshot.value && (snapshot.isStale || snapshot.refreshQueued)) {
            pollTimer = setTimeout(loadPage, 5_000);
          }
        })
        .catch(() => {
          if (!cancelled) {
            setLoadingMaps(false);
            setLiveMapsProgress(null);
            if (!cachedPage) setError("Couldn't load maps data. Try again later.");
          }
          if (!cancelled) setLiveMapsRefreshing(false);
        })
        ;
    };

    loadPage();

    return () => {
      cancelled = true;
      if (pollTimer) clearTimeout(pollTimer);
    };
  }, [liveBackendEnabled, liveMapsPageParams, liveMapsPageRequestKey, rememberLiveMapsPage, selectedCountry, windowActive]);

  useEffect(() => {
    if (!liveBackendEnabled || !windowActive) return;
    if (!liveMapsPageParams || !liveMapsPageRequestKey) return;
    const source = openLiveEventSource(selectedCountry);
    if (!source) return;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    let closed = false;

    const refreshCoreSnapshot = () => {
      if (refreshTimer) return;
      refreshTimer = setTimeout(() => {
        refreshTimer = null;
        fetchLiveMapsPageSnapshot(selectedCountry, liveMapsPageParams)
          .then((snapshot) => {
            if (closed || !snapshot.value) return;
            liveMapsPageCacheRef.current.clear();
            rememberLiveMapsPage({ ...snapshot.value, requestKey: liveMapsPageRequestKey });
            setLiveMapsRefreshing(snapshot.isStale || snapshot.refreshQueued);
            setLiveMapsProgress(snapshot.progress ?? null);
          })
          .catch(() => {});
      }, 750);
    };

    source.addEventListener("maps_farmed_update", refreshCoreSnapshot);
    return () => {
      closed = true;
      if (refreshTimer) clearTimeout(refreshTimer);
      source.close();
    };
  }, [liveBackendEnabled, liveMapsPageParams, liveMapsPageRequestKey, rememberLiveMapsPage, selectedCountry, windowActive]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const saved = readRandomPickSettings();
    const patch: Partial<MapsSearch> = {};

    if (!params.has("rWeight") && saved.rWeight && saved.rWeight !== rWeight) {
      patch.rWeight = saved.rWeight;
    }
    if (!params.has("rAvoidRepeats") && typeof saved.rAvoidRepeats === "boolean" && saved.rAvoidRepeats !== rAvoidRepeats) {
      patch.rAvoidRepeats = saved.rAvoidRepeats;
    }

    if (Object.keys(patch).length > 0) updateMapsSearch(patch);
  }, []);

  const liveVisiblePageItems = useMemo(() => {
    if (!currentLiveMapsPage) return [];
    if (hiddenUserIds.size === 0) return currentLiveMapsPage.items;

    if (currentLiveMapsPage.tab === "farmed") {
      return (currentLiveMapsPage.items as MapsFarmedEntry[])
        .map((entry) => {
          const players = entry.players.filter((p) => !hiddenUserIds.has(p.id));
          if (players.length === entry.players.length) return entry;
          return {
            ...entry,
            players,
          };
        })
        .filter((entry): entry is MapsFarmedEntry => entry !== null);
    }

    if (currentLiveMapsPage.tab === "popular") {
      return (currentLiveMapsPage.items as MapsAggregatedBeatmap[])
        .map((entry) => {
          const players = entry.players.filter((p) => !hiddenUserIds.has(p.id));
          if (players.length === entry.players.length) return entry;
          return {
            ...entry,
            players,
          };
        })
        .filter((entry): entry is MapsAggregatedBeatmap => entry !== null);
    }

    return (currentLiveMapsPage.items as MapsAggregatedFavourite[])
      .map((entry) => {
        const players = entry.players.filter((p) => !hiddenUserIds.has(p.id));
        if (players.length === entry.players.length) return entry;
        return { ...entry, players };
      })
      .filter((entry): entry is MapsAggregatedFavourite => entry !== null);
  }, [currentLiveMapsPage, hiddenUserIds]);

  // Browsing is fully server-paged; Random draws its own picks and never fills
  // this list.
  const currentList = liveBackendPaged ? liveVisiblePageItems : [];
  const currentTotal = currentLiveMapsPage?.total ?? 0;
  const totalPages = tab === "random" ? 0 : Math.ceil(currentTotal / PAGE_SIZE);
  const paginationTotal = liveBackendPaged ? knownLiveMapsTotal : currentTotal;
  const paginationTotalPages = tab === "random" ? 0 : Math.ceil(paginationTotal / PAGE_SIZE);

  useEffect(() => {
    if (tab === "random" || totalPages === 0 || page < totalPages) return;
    updateMapsSearch({ page: totalPages - 1 });
  }, [page, tab, totalPages]);

  // The three rankings are one surface seen through different lenses, so they
  // share a segmented control. "random" draws from the favourites pool, so it
  // renders fused onto the Favourites segment (see the view bar below).
  const browseLenses: { id: Exclude<Tab, "favourites" | "random" | "search" | "collections">; label: string }[] = [
    { id: "farmed", label: "Farmed" },
    { id: "popular", label: "Most Played" },
  ];
  const favouritesFamilyActive = tab === "favourites" || tab === "random";

  // Bridge the route's s-prefixed params <-> the Search section's UI state.
  const searchUiState: MapSearchUiState = useMemo(() => {
    const keys = parseTriStateCsv(mapsSearch.sKeys, SEARCH_KEY_VALUES);
    const statuses = parseTriStateCsv(mapsSearch.sStatuses, SEARCH_STATUS_VALUES);
    const patterns = parseTriStateCsv(mapsSearch.sPatterns, SEARCH_PATTERN_VALUES);
    return {
      q: mapsSearch.sQ,
      keys: [...keys.includes],
      keysExclude: [...keys.excludes],
      statuses: [...statuses.includes],
      statusesExclude: [...statuses.excludes],
      patterns: [...patterns.includes],
      patternsExclude: [...patterns.excludes],
      starMin: mapsSearch.sStarMin,
      starMax: mapsSearch.sStarMax,
      bpmMin: mapsSearch.sBpmMin,
      bpmMax: mapsSearch.sBpmMax,
      lenMin: mapsSearch.sLenMin,
      lenMax: mapsSearch.sLenMax,
      danMin: mapsSearch.sDanMin,
      danMax: mapsSearch.sDanMax,
      sort: mapsSearch.sSort,
      dir: mapsSearch.sDir,
      page: mapsSearch.page,
    };
  }, [mapsSearch]);
  const updateSearchUi = useCallback((patch: Partial<MapSearchUiState>) => {
    const next: Partial<MapsSearch> = {};
    if (patch.q !== undefined) next.sQ = patch.q;
    if (patch.keys !== undefined || patch.keysExclude !== undefined) {
      const current = parseTriStateCsv(mapsSearchRef.current.sKeys, SEARCH_KEY_VALUES);
      next.sKeys = serializeTriStateCsv(patch.keys ?? current.includes, patch.keysExclude ?? current.excludes);
    }
    if (patch.statuses !== undefined || patch.statusesExclude !== undefined) {
      const current = parseTriStateCsv(mapsSearchRef.current.sStatuses, SEARCH_STATUS_VALUES);
      next.sStatuses = serializeTriStateCsv(patch.statuses ?? current.includes, patch.statusesExclude ?? current.excludes);
    }
    if (patch.patterns !== undefined || patch.patternsExclude !== undefined) {
      const current = parseTriStateCsv(mapsSearchRef.current.sPatterns, SEARCH_PATTERN_VALUES);
      next.sPatterns = serializeTriStateCsv(patch.patterns ?? current.includes, patch.patternsExclude ?? current.excludes);
    }
    if (patch.starMin !== undefined) next.sStarMin = patch.starMin;
    if (patch.starMax !== undefined) next.sStarMax = patch.starMax;
    if (patch.bpmMin !== undefined) next.sBpmMin = patch.bpmMin;
    if (patch.bpmMax !== undefined) next.sBpmMax = patch.bpmMax;
    if (patch.lenMin !== undefined) next.sLenMin = patch.lenMin;
    if (patch.lenMax !== undefined) next.sLenMax = patch.lenMax;
    if (patch.danMin !== undefined) next.sDanMin = patch.danMin;
    if (patch.danMax !== undefined) next.sDanMax = patch.danMax;
    if (patch.sort !== undefined) next.sSort = patch.sort;
    if (patch.dir !== undefined) next.sDir = patch.dir;
    if (patch.page !== undefined) next.page = patch.page;
    // Remember the chosen sort (and its direction) so the next visit restores
    // it instead of resetting to the default. Reads the current value for
    // whichever half isn't in this patch so a lone direction flip still stores
    // the active sort.
    if (patch.sort !== undefined || patch.dir !== undefined) {
      const sort = patch.sort ?? mapsSearchRef.current.sSort;
      const dir = patch.dir ?? mapsSearchRef.current.sDir;
      if (isPersistableSearchSort(sort)) writeSearchSortPreference({ sort, dir });
    }
    updateMapsSearch(next);
  }, [updateMapsSearch]);

  // Restore the persisted search sort whenever the Search tab is shown with no
  // explicit sort in the URL (a bare visit, a nav-link entry, or having cleared
  // back to the default). An explicit URL sort (shared link, back/forward)
  // always wins. Gated on hydration so the applied sort never diverges from the
  // SSR-rendered default on the first client render.
  //
  // This re-runs on every sort change rather than once per mount, but it can't
  // fight the user: applying makes the URL non-default (so the guard below bails
  // next time), and because updateSearchUi writes the preference synchronously,
  // an explicit pick of the default has already updated the stored pref before
  // this effect re-reads it, so the reapply is a no-op.
  const hasHydrated = useHasHydrated();
  useEffect(() => {
    if (!hasHydrated || tab !== "search") return;
    const current = mapsSearchRef.current;
    // Both at default means the URL specified no sort, so the stored preference
    // is safe to apply; a non-default in either half is an explicit URL intent.
    if (current.sSort !== DEFAULT_MAPS_SEARCH.sSort || current.sDir !== DEFAULT_MAPS_SEARCH.sDir) return;
    const pref = readSearchSortPreference();
    const sSort = pref.sort ?? DEFAULT_MAPS_SEARCH.sSort;
    const sDir = pref.dir ?? DEFAULT_MAPS_SEARCH.sDir;
    if (sSort === current.sSort && sDir === current.sDir) return;
    // A new ordering invalidates the current page, same as any sort change.
    updateMapsSearch({ sSort, sDir, page: 0 });
  }, [hasHydrated, tab, mapsSearch.sSort, mapsSearch.sDir, updateMapsSearch]);

  const isLoading = liveBackendPaged ? liveMapsPagePending : loadingMaps;

  useEffect(() => {
    if (!liveBackendEnabled || !isLoading) return;

    let cancelled = false;
    const loadProgress = () => {
      fetchLiveMapsProgress(selectedCountry)
        .then((snapshot) => {
          if (!cancelled && snapshot.progress) setLiveMapsProgress(snapshot.progress);
        })
        .catch(() => {});
    };
    loadProgress();
    const id = window.setInterval(loadProgress, 2_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [isLoading, liveBackendEnabled, selectedCountry]);

  // ── Random tab: the server draws the picks ─────────────────────────────
  // Filters travel with the request and the response carries a batch of fully
  // hydrated picks plus the eligible counts, so the browser never holds the
  // favourites pool. Rerolls come out of the prefetched batch, which
  // MapsRandomDrawController owns along with the rest of the draw sequencing;
  // this component only mirrors what it reports into React state.
  const [randomDraw, setRandomDraw] = useState<LiveMapsRandomDrawValue | null>(null);
  const [randomPick, setRandomPick] = useState<LiveMapsRandomPick | null>(null);
  // A reroll with an empty buffer keeps the current card up and spins the
  // button instead of flashing a skeleton.
  const [rerollPending, setRerollPending] = useState(false);
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
  // Counts only what lives in the mobile sheet; sort has its own toolbar control.
  const activeFilterCount = useMemo(() => {
    if (tab === "random") return totalRandomActive;
    if (tab === "farmed") {
      return (
        (keyFilter !== "all" ? 1 : 0) +
        (modFilter !== "all" ? 1 : 0) +
        (ppFilter > 0 ? 1 : 0)
      );
    }
    if (tab === "popular") return keyFilter !== "all" ? 1 : 0;
    if (tab === "favourites") return statusFilter !== "all" ? 1 : 0;
    return 0;
  }, [tab, totalRandomActive, keyFilter, modFilter, ppFilter, statusFilter]);

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

  // Filters as the server sees them. Stable across rerolls, so the serialized
  // form doubles as the key that invalidates the prefetched queue.
  const randomDrawFilters = useMemo(
    () => buildRandomDrawFilters({
      rStatus: rStatusRaw,
      rKey: rKeyRaw,
      rPattern: rPatternRaw,
      rStars,
      rStarsMax,
      rWeight,
      hiddenUserIds,
    }),
    [rStatusRaw, rKeyRaw, rPatternRaw, rStars, rStarsMax, rWeight, hiddenUserIds],
  );
  // Avoid-repeats isn't a server filter (it only decides whether the recency
  // windows are sent) and the country isn't part of the filters, but both
  // invalidate the prefetched queue, so they ride in the key too.
  const randomDrawKey = useMemo(
    () => JSON.stringify({ ...randomDrawFilters, rAvoidRepeats, country: selectedCountry }),
    [randomDrawFilters, rAvoidRepeats, selectedCountry],
  );

  // The controller outlives every render, so the values a draw needs reach it
  // through a ref instead of rebuilding it whenever a filter moves.
  const drawContextRef = useRef({ country: selectedCountry, filters: randomDrawFilters, avoidRepeats: rAvoidRepeats, hiddenUserIds });
  drawContextRef.current = { country: selectedCountry, filters: randomDrawFilters, avoidRepeats: rAvoidRepeats, hiddenUserIds };

  const applyDrawEvent = useCallback((event: RandomDrawEvent<LiveMapsRandomPick, LiveMapsRandomDrawSnapshot>) => {
    switch (event.type) {
      case "loading":
        setLoadingMaps(event.loading);
        // A retry supersedes whatever the previous attempt left on screen.
        if (event.loading) setError(null);
        break;
      case "meta":
        setLiveMapsRefreshing(event.snapshot.isStale || event.snapshot.refreshQueued);
        setLiveMapsProgress(event.snapshot.progress ?? null);
        break;
      case "building":
        setMapsFirstBuild(event.firstBuild);
        break;
      case "value":
        setRandomDraw(event.value);
        setLoadingMaps(false);
        setMapsFirstBuild(false);
        setError(null);
        break;
      case "pick":
        setRandomPick(event.pick);
        break;
      case "pending":
        setRerollPending(event.pending);
        break;
      case "failed":
        setLoadingMaps(false);
        setLiveMapsRefreshing(false);
        setLiveMapsProgress(null);
        // A failed refill leaves the visible pick alone; only a cold tab errors.
        if (!event.hasValue) setError("Couldn't load maps data. Try again later.");
        break;
    }
  }, []);

  const drawControllerRef = useRef<MapsRandomDrawController<LiveMapsRandomPick, LiveMapsRandomDrawSnapshot> | null>(null);
  if (!drawControllerRef.current) {
    drawControllerRef.current = new MapsRandomDrawController<LiveMapsRandomPick, LiveMapsRandomDrawSnapshot>({
      batchSize: RANDOM_DRAW_BATCH_SIZE,
      filterDebounceMs: SEARCH_URL_DEBOUNCE_MS,
      host: {
        draw: (request, signal) => {
          const { country, filters } = drawContextRef.current;
          return fetchLiveMapsRandomDraw(country, buildRandomDrawParams(filters, request), { signal });
        },
        avoidRepeats: () => drawContextRef.current.avoidRepeats,
        isPickVisible: (pick) => !drawContextRef.current.hiddenUserIds.has(pick.player.id),
        emit: applyDrawEvent,
        schedule: (run, ms) => {
          const timer = setTimeout(run, ms);
          return () => clearTimeout(timer);
        },
      },
    });
  }
  const drawController = drawControllerRef.current;

  // A different country is a different pool. Declared above the draw effect so
  // the reset lands before the re-entry it triggers.
  useEffect(() => {
    drawController.reset();
    setRandomDraw(null);
    setRandomPick(null);
    setRerollPending(false);
  }, [drawController, selectedCountry]);

  // Entering the tab (or a country switch / rebuild) draws and commits. A later
  // filter change only refreshes the counts and re-warms the queue: filter
  // changes never auto-reroll, the user must click Reroll.
  useEffect(() => {
    if (!liveBackendEnabled || tab !== "random") return;
    drawController.enterTab(randomDrawKey);
    // Leaving the tab (or superseding this draw with a filter change) drops the
    // in-flight request and the cold-country repoll; the next entry re-arms
    // whatever it still needs.
    return () => drawController.stop();
  }, [drawController, liveBackendEnabled, randomDrawKey, tab]);

  // The page can unmount from any tab, so quiesce the controller unconditionally
  // rather than leaning on the draw effect's cleanup.
  useEffect(() => () => drawController.stop(), [drawController]);

  const randomPickCount = randomDraw?.totalPicks ?? 0;
  const hasActiveFilters =
    tab === "random"
      ? totalRandomActive > 0
      : Boolean(searchQuery) || activeFilterCount > 0;

  const resetFilters = () => {
    navigate({
      to: "/maps",
      search: { ...DEFAULT_MAPS_SEARCH, tab, country: mapsSearch.country },
      replace: true,
      resetScroll: false,
    });
  };

  // ── Browse-tab filters (shared by the desktop chip row and mobile sheet) ──
  const browseSortOptions = tab === "farmed" ? FARMED_SORT_OPTIONS : tab === "popular" ? POPULAR_SORT_OPTIONS : [];
  const browseSortValue = tab === "farmed" ? farmedSort : beatmapSort;
  const setBrowseSort = (id: string) => {
    if (tab === "farmed") updateMapsSearch({ farmedSort: id as FarmedSort, page: 0 });
    else updateMapsSearch({ beatmapSort: id as BeatmapSort, page: 0 });
  };

  const browseFilterGroups = (
    <>
      {tab === "random" && (
        <>
          <ChipGroup label="Status">
            {RANDOM_STATUS_OPTIONS.map((s) => (
              <TriStatePill
                key={s}
                color={STATUS_COLOR[s]}
                pill
                mode={getTriStateMode(randomStatus, s)}
                hasAnyActive={triStateActive(randomStatus) > 0}
                onClick={() => updateMapsSearch({ rStatus: cycleTriStateCsv(rStatusRaw, s) })}
                onContextMenu={() => updateMapsSearch({ rStatus: reverseCycleTriStateCsv(rStatusRaw, s) })}
              >
                {s.charAt(0).toUpperCase() + s.slice(1)}
              </TriStatePill>
            ))}
          </ChipGroup>

          <ChipGroup label="Keys">
            {RANDOM_KEY_OPTIONS.map((k) => (
              <TriStatePill
                key={k}
                mode={getTriStateMode(randomKey, k)}
                hasAnyActive={triStateActive(randomKey) > 0}
                onClick={() => updateMapsSearch({ rKey: cycleTriStateCsv(rKeyRaw, k) })}
                onContextMenu={() => updateMapsSearch({ rKey: reverseCycleTriStateCsv(rKeyRaw, k) })}
              >
                {k.toUpperCase()}
              </TriStatePill>
            ))}
          </ChipGroup>

          <ChipGroup label="Tags">
            {RANDOM_PATTERN_OPTIONS.map((p) => (
              <TriStatePill
                key={p}
                color={RANDOM_PATTERN_CHIP_COLOR[p]}
                mode={getTriStateMode(randomPattern, p)}
                hasAnyActive={triStateActive(randomPattern) > 0}
                onClick={() => updateMapsSearch({ rPattern: cycleTriStateCsv(rPatternRaw, p) })}
                onContextMenu={() => updateMapsSearch({ rPattern: reverseCycleTriStateCsv(rPatternRaw, p) })}
              >
                {RANDOM_PATTERN_LABEL[p]}
              </TriStatePill>
            ))}
          </ChipGroup>

          <ChipGroup label="Difficulty">
            <StarRangePill
              lo={RANDOM_STAR_MIN}
              hi={RANDOM_STAR_MAX}
              min={rStars}
              max={rStarsMax}
              step={0.1}
              ariaLabel="Star rating"
              onChange={(nextMin, nextMax) => updateMapsSearch({ rStars: nextMin, rStarsMax: nextMax })}
            />
          </ChipGroup>
        </>
      )}

      {(tab === "farmed" || tab === "popular") && (
        <ChipGroup label="Keys">
          {(["4k", "7k", "other"] as KeyFilter[]).map((k) => (
            <Chip key={k} active={keyFilter === k} onClick={() => updateMapsSearch({ key: keyFilter === k ? "all" : k, page: 0 })}>
              {k === "other" ? "Other" : k.toUpperCase()}
            </Chip>
          ))}
        </ChipGroup>
      )}

      {tab === "farmed" && (
        <>
          <ChipGroup label="Mods">
            {(["dt", "ht", "nm"] as ModFilter[]).map((m) => (
              <Chip key={m} active={modFilter === m} onClick={() => updateMapsSearch({ mod: modFilter === m ? "all" : m, page: 0 })}>
                {m.toUpperCase()}
              </Chip>
            ))}
          </ChipGroup>
          <ChipGroup label="Min PP">
            <MinPpSlider value={ppFilter} onChange={(v) => updateMapsSearch({ pp: v, page: 0 })} />
          </ChipGroup>
        </>
      )}

      {tab === "favourites" && (
        <ChipGroup label="Status">
          {(["ranked", "loved", "graveyard", "other"] as const).map((s) => (
            <StatusChip
              key={s}
              id={s}
              label={s === "other" ? "Other" : s.charAt(0).toUpperCase() + s.slice(1)}
              active={statusFilter === s}
              onClick={() => updateMapsSearch({ status: statusFilter === s ? "all" : s, page: 0 })}
            />
          ))}
        </ChipGroup>
      )}
    </>
  );

  const handleDevRebuildAll = async () => {
    if (rebuilding || !liveBackendEnabled) return;
    setRebuilding(true);
    try {
      await runLiveBackendAdminAction({ data: { path: `/api/admin/refresh-maps?country=${selectedCountry}` } });
      if (tab === "random") {
        await drawController.redraw();
      } else if (liveMapsPageParams && liveMapsPageRequestKey) {
        const snapshot = await fetchLiveMapsPageSnapshot(selectedCountry, liveMapsPageParams);
        setLiveMapsProgress(snapshot.progress ?? null);
        if (snapshot.value) {
          liveMapsPageCacheRef.current.clear();
          rememberLiveMapsPage({ ...snapshot.value, requestKey: liveMapsPageRequestKey });
        }
      }
    } catch {
      setError("Rebuild failed.");
    } finally {
      setRebuilding(false);
    }
  };

  const mapsUpdatedAt =
    tab === "random"
      ? randomDraw?.favouritesGeneratedAt ?? null
      : tab === "farmed"
        ? currentLiveMapsPage?.farmedGeneratedAt
        : currentLiveMapsPage?.favouritesGeneratedAt;
  const showMapsSummary =
    !isLoading && !error && (tab === "random" ? !!randomDraw : !!currentLiveMapsPage);
  const liveMapsProgressLabel =
    liveBackendEnabled &&
    liveMapsProgress &&
    (liveMapsProgress.status === "queued" || liveMapsProgress.status === "running") &&
    (mapsFirstBuild || (!liveBackendPaged && loadingMaps && !randomDraw))
      ? formatLiveMapsProgress(liveMapsProgress)
      : null;
  const liveMapsPageSliceLoading = liveBackendPaged && liveMapsPagePending && !mapsFirstBuild;
  const mapsLoadingLabel =
    liveMapsProgressLabel
      ?? (mapsFirstBuild
        ? "Building maps..."
        : liveMapsRefreshing && !liveMapsPageSliceLoading
          ? "Refreshing maps..."
          : "Loading maps...");

  if (!liveBackendEnabled) {
    return (
      <div className="flex-1">
        <PageHeader iconSrc="/images/icons/rankings.svg" title={isGlobalCatalogTab ? "Mania maps" : lensTitle} />
        <LiveBackendRequired />
      </div>
    );
  }

  return (
    <div className="flex-1">
      <PageHeader
        iconSrc="/images/icons/rankings.svg"
        title={isGlobalCatalogTab ? "Mania maps" : lensTitle}
        right={isGlobalCatalogTab ? null : (
          <div className="flex flex-wrap items-center gap-2 sm:justify-end">
            {isLoading && !error && (
              <div className="flex items-center gap-1.5">
                <div className="w-3 h-3 border-2 border-osu-pink/40 border-t-osu-pink rounded-full animate-spin" />
                <span className="text-[10px] text-osu-f1 tabular-nums">
                  {mapsLoadingLabel}
                </span>
              </div>
            )}
            {showMapsSummary && mapsUpdatedAt && (
              <span className="text-[10px] text-osu-f1">
                {tab === "random"
                  ? `${formatNumber(randomPickCount)} possible picks · ${formatNumber(randomDraw?.uniqueSets ?? 0)} unique sets`
                  : `${formatNumber(currentTotal)} maps`} &middot; updated {formatTimeAgo(mapsUpdatedAt)}
              </span>
            )}
            {canUseAdminFeatures && !isLoading && !error && (randomDraw || currentLiveMapsPage) && (
              <button
                onClick={handleDevRebuildAll}
                disabled={rebuilding}
                className="px-2 py-1 rounded-lg bg-osu-red/20 border border-osu-red/30 text-[10px] text-osu-red font-semibold hover:bg-osu-red/30 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                title="Force rebuild maps data for everyone (dev only)"
              >
                {rebuilding ? "Rebuilding..." : "Rebuild"}
              </button>
            )}
          </div>
        )}
      />

      {warming && <CountryWarming country={selectedCountry} />}

      {!warming && (
      <>
      {/* ── View bar: the rankings grouped into one segmented control.
          "random" is a shuffle of the favourites pool, so it renders as the
          right half of a split Favourites segment ─────────────────────────── */}
      <div className="bg-osu-d5 border-b border-osu-b3/30">
        <div className="max-w-[1200px] mx-auto px-4 sm:px-5 py-2 flex items-center gap-2.5 overflow-x-auto scrollbar-hide">
          <button
            onClick={() => updateMapsSearch({ tab: "search", page: 0 })}
            aria-pressed={tab === "search"}
            className={`relative px-3 py-2.5 text-[12px] font-medium whitespace-nowrap cursor-pointer transition-colors duration-[120ms] ${
              tab === "search" ? "text-osu-c1" : "text-osu-f1 hover:text-osu-l2"
            }`}
          >
            search
            {tab === "search" && (
              <span aria-hidden="true" className="absolute bottom-0 left-2 right-2 h-0.5 rounded-full bg-osu-h1" />
            )}
          </button>

          <button
            onClick={() => updateMapsSearch({ tab: "collections", page: 0 })}
            aria-pressed={tab === "collections"}
            className={`relative px-3 py-2.5 text-[12px] font-medium whitespace-nowrap cursor-pointer transition-colors duration-[120ms] ${
              tab === "collections" ? "text-osu-c1" : "text-osu-f1 hover:text-osu-l2"
            }`}
          >
            collections
            {tab === "collections" && (
              <span aria-hidden="true" className="absolute bottom-0 left-2 right-2 h-0.5 rounded-full bg-osu-h1" />
            )}
          </button>

          <span aria-hidden="true" className="h-4 w-px shrink-0 bg-osu-b3/40" />

          <div className="flex items-center gap-0.5 rounded-lg bg-osu-b4/70 p-0.5">
            {browseLenses.map((lens) => (
              <button
                key={lens.id}
                onClick={() => updateMapsSearch({ tab: lens.id, page: 0 })}
                aria-pressed={tab === lens.id}
                className={`rounded-md px-3 py-1 text-[12px] font-medium whitespace-nowrap transition-colors duration-[120ms] cursor-pointer ${
                  tab === lens.id
                    ? "bg-osu-pink/20 text-osu-pink-light"
                    : "text-osu-f1 hover:text-osu-l2"
                }`}
              >
                {lens.label}
              </button>
            ))}

            <div
              className={`flex items-center rounded-md transition-colors duration-[120ms] ${
                favouritesFamilyActive ? "bg-osu-pink/20" : ""
              }`}
            >
              <button
                onClick={() => updateMapsSearch({ tab: "favourites", page: 0 })}
                aria-pressed={tab === "favourites"}
                className={`rounded-md px-3 py-1 text-[12px] font-medium whitespace-nowrap transition-colors duration-[120ms] cursor-pointer ${
                  tab === "favourites"
                    ? "text-osu-pink-light"
                    : favouritesFamilyActive
                      ? "text-osu-pink-light/50 hover:text-osu-pink-light"
                      : "text-osu-f1 hover:text-osu-l2"
                }`}
              >
                Favourites
              </button>
              <span
                aria-hidden="true"
                className={`h-3 w-px shrink-0 ${favouritesFamilyActive ? "bg-osu-pink-light/25" : "bg-osu-b3/40"}`}
              />
              <button
                onClick={() => updateMapsSearch({ tab: "random", page: 0 })}
                aria-pressed={tab === "random"}
                title="Random picks from the favourites pool"
                className={`flex items-center gap-1 rounded-md px-2.5 py-1 text-[12px] font-medium whitespace-nowrap transition-colors duration-[120ms] cursor-pointer ${
                  tab === "random"
                    ? "text-osu-pink-light"
                    : favouritesFamilyActive
                      ? "text-osu-pink-light/50 hover:text-osu-pink-light"
                      : "text-osu-f1 hover:text-osu-l2"
                }`}
              >
                <Dices className="h-3 w-3" aria-hidden="true" />
                Random
              </button>
            </div>
          </div>
        </div>
      </div>

      {isGlobalCatalogTab && (
        tab === "search" ? (
          <MapSearchSection
            state={searchUiState}
            onChange={updateSearchUi}
            liveBackendEnabled={liveBackendEnabled}
          />
        ) : (
          <MapCollectionsSection
            selectedCollectionId={mapsSearch.col}
            onSelect={(id) => updateMapsSearch({ col: id })}
            liveBackendEnabled={liveBackendEnabled}
          />
        )
      )}

      {!isGlobalCatalogTab && (
      <>

      {/* ── Filter bar: same language as the search tab (icon search bar with
          live count, chip groups, sort-by text links, mobile toolbar+sheet) ── */}
      <div className="bg-osu-b5">
        <div className="max-w-[1200px] mx-auto px-4 sm:px-5 pt-4 flex flex-col gap-4">
          {tab !== "random" && (
            <div className="flex items-center gap-3">
              <div className="relative flex-1">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-osu-f1/50">
                  <circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" />
                </svg>
                <input
                  type="text"
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                  placeholder="Search title, artist, mapper, or difficulty"
                  aria-label="Search by title, artist, mapper, or difficulty"
                  className={`w-full bg-osu-b4 border border-osu-b3/30 rounded-lg pl-10 py-2.5 text-[14px] text-osu-l1 placeholder:text-osu-f1/55 focus:outline-none focus:border-osu-pink/50 transition-colors ${searchInput ? "pr-10" : "pr-3"}`}
                />
                {searchInput && (
                  <button
                    type="button"
                    onClick={() => setSearchInput("")}
                    aria-label="Clear search"
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 flex h-6 w-6 items-center justify-center rounded-md text-osu-f1/55 hover:text-osu-l1 hover:bg-osu-b3 transition-colors cursor-pointer"
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden="true">
                      <path d="M18 6 6 18M6 6l12 12" />
                    </svg>
                  </button>
                )}
              </div>
              <span className="shrink-0 text-[12px] text-osu-f1 tabular-nums" role="status" aria-live="polite">
                {isLoading ? "Loading maps..." : `${formatNumber(currentTotal)} maps`}
              </span>
            </div>
          )}

          {/* Mobile toolbar: filters collapse behind a toggle, sort is a dropdown */}
          <div className="flex items-center gap-2 sm:hidden">
            <button
              type="button"
              onClick={() => setFiltersOpen(true)}
              aria-haspopup="dialog"
              aria-expanded={filtersOpen}
              className="inline-flex items-center gap-1.5 rounded-md px-3 py-2 text-[12.5px] font-semibold cursor-pointer transition-colors bg-osu-b4 text-osu-l2 hover:bg-osu-b3 hover:text-osu-l1"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5" aria-hidden="true">
                <path d="M3 6h18M7 12h10M10 18h4" />
              </svg>
              Filters
              {activeFilterCount > 0 && (
                <span className="rounded-full bg-osu-pink px-1.5 text-[10px] font-bold leading-4 text-white tabular-nums">
                  {activeFilterCount}
                </span>
              )}
            </button>
            {tab === "random" && (
              <span className="ml-auto text-[11px] text-osu-f1 tabular-nums">
                {formatNumber(randomPickCount)} {randomPickCount === 1 ? "pick" : "possible picks"}
              </span>
            )}
            {browseSortOptions.length > 0 && (
              <>
                <div className="ml-auto">
                  <SortSelect options={browseSortOptions} value={browseSortValue} onChange={setBrowseSort} />
                </div>
                <DirButton dir={sortDir} onToggle={() => updateMapsSearch({ dir: sortDir === "asc" ? "desc" : "asc", page: 0 })} />
              </>
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

          {/* Mobile bottom sheet. Always mounted (translated offscreen, hidden
              once the slide-down finishes) so open/close only moves an existing
              compositor layer. */}
          <div
            className="sm:hidden fixed bottom-0 left-0 right-0 z-50 flex max-h-[75vh] flex-col rounded-t-2xl bg-osu-b5 ring-1 ring-white/10 will-change-transform"
            style={{
              transform: filtersOpen ? `translateY(${dragOffset}px)` : "translateY(105%)",
              // translateY(105%) alone isn't enough on phones: when the URL bar
              // collapses on scroll the fixed bottom anchor shifts and the top
              // edge peeks up. Hiding it outright once closed kills the peek;
              // the hide is delayed one transition so the slide-down still plays.
              visibility: filtersOpen ? "visible" : "hidden",
              transition: isDragging
                ? "none"
                : filtersOpen
                  ? "transform 280ms cubic-bezier(0.32, 0.72, 0, 1)"
                  : "transform 280ms cubic-bezier(0.32, 0.72, 0, 1), visibility 0s linear 280ms",
              pointerEvents: filtersOpen ? "auto" : "none",
            }}
            role={filtersOpen ? "dialog" : undefined}
            aria-modal={filtersOpen ? true : undefined}
          >
            {/* Drag handle — also the swipe-to-dismiss touch zone */}
            <div
              onTouchStart={handleDragStart}
              onTouchMove={handleDragMove}
              onTouchEnd={handleDragEnd}
              onTouchCancel={handleDragEnd}
              className="shrink-0 cursor-grab touch-none pt-2 active:cursor-grabbing"
            >
              <div className="mx-auto h-1 w-9 rounded-full bg-osu-b3" aria-hidden="true" />
              <div className="flex items-center gap-2 px-4 pt-2">
                <span className="text-[13px] font-bold text-osu-l1">Filters</span>
                {activeFilterCount > 0 && (
                  <span className="rounded-full bg-osu-pink px-1.5 text-[10px] font-bold leading-4 text-white tabular-nums">
                    {activeFilterCount}
                  </span>
                )}
              </div>
            </div>
            <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-3.5">
              {browseFilterGroups}
            </div>
            <div className="flex items-center justify-between gap-3 border-t border-osu-b3/20 px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
              <button
                type="button"
                onClick={resetFilters}
                disabled={!hasActiveFilters}
                className={`text-[12px] transition-colors ${
                  hasActiveFilters ? "text-osu-f1 hover:text-osu-pink-light cursor-pointer" : "text-osu-f1/40 cursor-default"
                }`}
              >
                Clear all
              </button>
              <button
                type="button"
                onClick={() => setFiltersOpen(false)}
                className="rounded-md bg-osu-pink px-4 py-2 text-[12.5px] font-bold text-white hover:bg-osu-pink-light transition-colors cursor-pointer"
              >
                {tab === "random"
                  ? `Show ${formatNumber(randomPickCount)} picks`
                  : `Show ${formatNumber(currentTotal)} maps`}
              </button>
            </div>
          </div>

          {/* Desktop: chip groups inline */}
          <div className="hidden sm:flex flex-wrap items-start gap-x-10 gap-y-4">
            {browseFilterGroups}
            {tab === "random" && (
              <span className="ml-auto self-center text-[11px] text-osu-f1 tabular-nums">
                {formatNumber(randomPickCount)} {randomPickCount === 1 ? "pick" : "possible picks"}
              </span>
            )}
          </div>

          {/* Sort + actions (desktop; phones sort from the toolbar above). Plain
              text links like the search tab: the active sort is white with a
              direction caret, and clicking it again flips the direction. */}
          {(browseSortOptions.length > 0 || hasActiveFilters) && (
            <div className="hidden sm:flex flex-wrap items-center justify-between gap-3 border-t border-osu-b3/15 pt-3.5">
              <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
                {browseSortOptions.length > 0 && (
                  <>
                    <span className="text-[10px] font-bold uppercase tracking-[0.08em] text-osu-f1/55">Sort by</span>
                    {browseSortOptions.map((option) => {
                      const isActive = browseSortValue === option.id;
                      return (
                        <button
                          key={option.id}
                          type="button"
                          onClick={() =>
                            isActive
                              ? updateMapsSearch({ dir: sortDir === "asc" ? "desc" : "asc", page: 0 })
                              : setBrowseSort(option.id)
                          }
                          aria-pressed={isActive}
                          title={isActive ? "Flip direction" : undefined}
                          className={`inline-flex items-center gap-1 text-[12.5px] font-semibold transition-colors cursor-pointer ${
                            isActive ? "text-white" : "text-osu-f1 hover:text-osu-pink-light"
                          }`}
                        >
                          {option.label}
                          {isActive && (
                            <svg
                              viewBox="0 0 20 20"
                              fill="currentColor"
                              className={`h-3 w-3 text-osu-pink-light transition-transform duration-150 ${sortDir === "asc" ? "rotate-180" : ""}`}
                              aria-hidden="true"
                            >
                              <path d="M5.25 7.5 10 12.25 14.75 7.5H5.25Z" />
                            </svg>
                          )}
                        </button>
                      );
                    })}
                  </>
                )}
              </div>
              {hasActiveFilters && (
                <button
                  type="button"
                  onClick={resetFilters}
                  className="text-[12px] text-osu-f1 hover:text-osu-pink-light transition-colors cursor-pointer"
                >
                  Clear all
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ── Content ──────────────────────────────────────────────────── */}
      <div className="bg-osu-b5">
        <div className="max-w-[1200px] mx-auto px-4 sm:px-5 py-6">
          {error && (
            <div className="text-center py-16 text-osu-f1 text-sm">{error}</div>
          )}

          {/* Loading skeleton */}
          {!error && isLoading && (liveBackendPaged ? !currentLiveMapsPage : !randomDraw) && (
            <div className="space-y-3">
              {mapsFirstBuild && (
                <div className="rounded-lg border border-osu-b3/30 bg-osu-b4/60 px-3.5 py-2.5 text-[11px] leading-relaxed text-osu-f1">
                  <span className="font-semibold text-osu-c2">First time loading {countryName} maps.</span>{" "}
                  Scanning its top players' plays and favourites. This can take a minute, and the page will fill in on its own.
                </div>
              )}
              <MapsLoadingIndicator firstBuild={mapsFirstBuild} />
              {tab === "random" ? (
                <RandomPickLoadingSkeleton />
              ) : (
                <MapsCardGridSkeleton count={PAGE_SIZE} />
              )}
            </div>
          )}

          {/* Card grid */}
          {tab !== "random" && !error && currentList.length > 0 && (
            <div key={`${tab}-${page}`} className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3 cards-enter">
                {tab === "farmed"
                  ? (currentList as MapsFarmedEntry[]).map((map) => (
                      <FarmedCard
                        key={map.beatmapId}
                        map={map}
                        onPlayerClick={(u) => navigate({ to: "/player/$username", params: { username: u } })}
                        onOpenDetails={() => setDetailsOpen({ kind: "farmed", map })}
                      />
                    ))
                  : tab === "popular"
                    ? (currentList as MapsAggregatedBeatmap[]).map((map) => (
                        <MostPlayedCard
                          key={map.beatmapId}
                          map={map}
                          onPlayerClick={(u) => navigate({ to: "/player/$username", params: { username: u } })}
                          onOpenDetails={() => setDetailsOpen({ kind: "popular", map })}
                        />
                      ))
                    : (currentList as MapsAggregatedFavourite[]).map((fav) => (
                        <FavouriteCard
                          key={fav.beatmapsetId}
                          fav={fav}
                          onPlayerClick={(u) => navigate({ to: "/player/$username", params: { username: u } })}
                          onOpenDetails={() => setDetailsOpen({ kind: "favourite", fav })}
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
          {tab === "random" && !error && !isLoading && randomDraw && (
            <div className="max-w-[640px] mx-auto space-y-5">
              {randomPick ? (
                <>
                  <div className="flex flex-row items-center justify-between gap-3">
                    <button
                      onClick={() => navigate({ to: "/player/$username", params: { username: randomPick.player.username } })}
                      className="flex items-center gap-3 group cursor-pointer min-w-0 text-left"
                    >
                      <Avatar url={randomPick.player.avatarUrl} size={44} />
                      <div className="min-w-0">
                        <div className="text-[10px] uppercase tracking-wider text-osu-f1">
                          random pick from
                        </div>
                        <div className="text-[15px] font-semibold text-osu-l2 group-hover:text-white transition-colors truncate">
                          {randomPick.player.username}
                        </div>
                        <div className="text-[10px] text-osu-f1">
                          {randomPick.player.favouriteCount} favourites
                        </div>
                      </div>
                    </button>
                    <div ref={rerollMenuRef} className="shrink-0 relative">
                      <div className="flex items-stretch rounded-lg bg-osu-pink/20 border border-osu-pink/30 overflow-hidden">
                        <button
                          onClick={() => { setRerollMenuOpen(false); void drawController.reroll(); }}
                          disabled={rerollPending}
                          className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] text-osu-pink-light font-semibold hover:bg-osu-pink/30 transition-colors cursor-pointer disabled:cursor-not-allowed"
                        >
                          {rerollPending && (
                            <span className="w-3 h-3 border-2 border-osu-pink-light/40 border-t-osu-pink-light rounded-full animate-spin" aria-hidden="true" />
                          )}
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
                              id: "favourites" as const,
                              label: "Equal chance per map",
                              desc: "Every favourited map is equally likely. Players with bigger collections show up more often as a result.",
                            },
                            {
                              id: "players" as const,
                              label: "Equal chance per player",
                              desc: "Each player is equally likely, no matter how many favourites they have.",
                            },
                          ]).map((opt) => {
                            const active = rWeight === opt.id;
                            return (
                              <button
                                key={opt.id}
                                onClick={() => {
                                  writeRandomPickSettings({ rWeight: opt.id });
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
                            onClick={() => {
                              const nextAvoidRepeats = !rAvoidRepeats;
                              writeRandomPickSettings({ rAvoidRepeats: nextAvoidRepeats });
                              updateMapsSearch({ rAvoidRepeats: nextAvoidRepeats });
                            }}
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
                              Skips the last few players and maps you were shown.
                            </div>
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                  <div key={`random-${randomPick.player.id}-${randomPick.beatmapset.id}`} className="cards-enter">
                    <RandomCard bm={randomPick.beatmapset} />
                  </div>
                </>
              ) : randomPickCount > 0 ? (
                <RandomPickLoadingSkeleton />
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
          {tab !== "random" && paginationTotalPages > 1 && (
            <div
              className="sticky bottom-0 z-10 -mx-4 sm:-mx-5 mt-6 px-4 sm:px-5 py-2 bg-osu-b5/90 backdrop-blur-sm border-t border-osu-b3/30 [&>div]:!mt-0 relative after:absolute after:left-0 after:right-0 after:top-full after:h-4 after:bg-osu-b5/90 after:backdrop-blur-sm after:content-['']"
              style={{ paddingBottom: "calc(0.5rem + env(safe-area-inset-bottom, 0px))" }}
            >
              <Pagination page={page} totalPages={paginationTotalPages} onPageChange={(p) => updateMapsSearch({ page: p })} />
            </div>
          )}
        </div>
      </div>
      </>
      )}
      </>
      )}

      <MapDetailsModal
        details={detailsOpen}
        country={selectedCountry}
        onClose={() => setDetailsOpen(null)}
      />
      <MapDetailModal
        entry={sharedMapId > 0 ? sharedMapEntry : null}
        onClose={() => updateMapsSearch({ map: 0 })}
      />
    </div>
  );
}

// ── Loading indicator ─────────────────────────────────────────────────────

const LOADING_STEPS = [
  "Loading maps...",
  "Almost there...",
];

function MapsLoadingIndicator({ firstBuild }: { firstBuild: boolean }) {
  const [stepIndex, setStepIndex] = useState(0);

  useEffect(() => {
    if (firstBuild) return;
    const id = setInterval(() => {
      setStepIndex((i) => (i + 1) % LOADING_STEPS.length);
    }, 3000);
    return () => clearInterval(id);
  }, [firstBuild]);

  const label = firstBuild
    ? "Building maps for the first time..."
    : LOADING_STEPS[stepIndex];

  return (
    <div className="flex items-center gap-3">
      <div className="flex-1 h-1 rounded-full bg-osu-b3/40 overflow-hidden">
        <div className="h-full w-1/3 rounded-full bg-osu-pink animate-[indeterminate_1.5s_ease-in-out_infinite]" />
      </div>
      <span className="text-[11px] text-osu-f1 flex-shrink-0">{label}</span>
    </div>
  );
}

function MapsCardGridSkeleton({ count }: { count: number }) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
      {Array.from({ length: count }).map((_, i) => (
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
  );
}

function RandomPickLoadingSkeleton() {
  return (
    <div className="max-w-[640px] mx-auto space-y-5">
      <div className="flex flex-row items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <Skeleton className="h-11 w-11 rounded-full shrink-0" />
          <div className="min-w-0 space-y-1.5">
            <Skeleton className="h-2.5 w-24" />
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-2.5 w-20" />
          </div>
        </div>
        <div className="flex h-8 w-20 shrink-0 overflow-hidden rounded-lg border border-osu-pink/25 bg-osu-pink/10">
          <Skeleton className="h-full flex-1 rounded-none" />
          <div className="w-px bg-osu-pink/20" />
          <Skeleton className="h-full w-7 rounded-none" />
        </div>
      </div>

      <RandomCardSkeleton />
    </div>
  );
}

function RandomCardSkeleton() {
  return (
    <div className="relative w-[640px] max-w-full">
      <div className="overflow-hidden rounded-2xl border border-osu-b3/20 bg-osu-b4">
        <div className="relative h-[220px] bg-osu-b6">
          <Skeleton className="h-full w-full rounded-none" />
          <Skeleton className="absolute left-3 top-3 h-5 w-12 rounded-full" />
          <div className="absolute right-3 top-3 flex gap-1">
            <Skeleton className="h-5 w-7" />
            <Skeleton className="h-5 w-20" />
          </div>
          <div className="absolute bottom-3 left-4 right-4 space-y-1.5">
            <Skeleton className="h-5 w-1/2" />
            <Skeleton className="h-3.5 w-1/3" />
          </div>
        </div>

        <div className="space-y-3 px-4 py-3">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div className="min-w-0 space-y-1.5">
              <Skeleton className="h-3 w-40" />
              <Skeleton className="h-2.5 w-24" />
            </div>
            <div className="flex w-full items-center justify-between gap-4 sm:w-auto sm:justify-start">
              <Skeleton className="h-4 w-14" />
              <Skeleton className="h-4 w-16" />
              <Skeleton className="hidden h-7 w-16 rounded-full sm:block" />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <Skeleton className="h-5 w-8 rounded-full" />
            <Skeleton className="h-5 w-14 rounded-full" />
          </div>

          <div className="flex items-center gap-2">
            <Skeleton className="h-2.5 w-6" />
            <Skeleton className="h-8 flex-1" />
            <Skeleton className="h-7 w-12" />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Skeleton className="h-8 w-8 rounded-full shrink-0" />
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <Skeleton className="h-1 flex-1 rounded-full" />
              <Skeleton className="h-2.5 w-16 shrink-0" />
            </div>
            <Skeleton className="h-5 w-5 shrink-0" />
            <Skeleton className="h-1 w-12 rounded-full shrink-0" />
          </div>
        </div>
      </div>

      <div
        className="relative mt-4 min-h-[420px] overflow-visible md:absolute md:left-[calc(100%_+_24px)] md:top-[-52px] md:mt-0 md:h-[calc(100%+52px)] md:w-[300px] md:min-h-[calc(100%+52px)]"
      >
        <Skeleton className="absolute left-1/2 top-1/2 h-8 w-28 -translate-x-1/2 -translate-y-1/2 md:left-[150px]" />
      </div>
    </div>
  );
}

// ── Filter UI ──────────────────────────────────────────────────────────────

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
    <div className="flex h-[29px] items-center gap-3 w-full sm:w-[240px]">
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
        className={`flex-1 min-w-[120px] h-1 appearance-none rounded-full cursor-pointer
          [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-osu-pink-light [&::-webkit-slider-thumb]:shadow-[0_0_0_2px_rgba(0,0,0,0.35)] [&::-webkit-slider-thumb]:cursor-grab
          [&::-moz-range-thumb]:appearance-none [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:w-3.5 [&::-moz-range-thumb]:h-3.5 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-osu-pink-light [&::-moz-range-thumb]:shadow-[0_0_0_2px_rgba(0,0,0,0.35)] [&::-moz-range-thumb]:cursor-grab`}
      />
      <button
        type="button"
        onClick={() => active && onChange(0)}
        className={`shrink-0 w-20 text-left text-[11px] font-semibold tabular-nums transition-colors ${
          active ? "text-osu-pink-light cursor-pointer hover:text-osu-pink" : "text-osu-f1/55 cursor-default"
        }`}
        title={active ? "Clear" : undefined}
      >
        {show ? `${Math.round(localValue)}pp+` : "Any"}{active ? " ✕" : ""}
      </button>
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
    // DT/NC is dominant once more than FARMED_DOMINANT_MOD_SHARE of farmers use it.
    if (dtCount > players.length * FARMED_DOMINANT_MOD_SHARE) return "DT";
    return null;
  }

  // HT leads — also require the top PP play to be HT before flagging it.
  if (htCount > players.length * FARMED_DOMINANT_MOD_SHARE) {
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
      className="absolute flex items-center justify-center rounded-full border border-osu-b5 z-10 overflow-hidden"
      style={{ width: size, height: size, top: offset, right: offset, backgroundColor: bg }}
      title={mod}
    >
      <ModGlyph
        file={file}
        color={`color-mix(in srgb-linear, black, ${bg} 10%)`}
        style={{ width: "110%", height: "110%" }}
      />
    </span>
  );
}

// ── Player avatars ─────────────────────────────────────────────────────────

function PlayerAvatars({
  players,
  totalCount,
  onPlayerClick,
  onMoreClick,
}: {
  players: Array<{ id: number; username: string; avatarUrl: string; pp?: number; count?: number; mods?: string[]; scoreUrl?: string | null }>;
  totalCount?: number;
  onPlayerClick: (player: { id: number; username: string; avatarUrl: string; pp?: number; count?: number; mods?: string[]; scoreUrl?: string | null }) => void;
  onMoreClick?: () => void;
}) {
  const visible = players.slice(0, VISIBLE_AVATARS);
  const total = Math.max(totalCount ?? players.length, players.length);
  const overflow = total - VISIBLE_AVATARS;

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
        <button
          type="button"
          onClick={onMoreClick}
          className="text-[8px] text-osu-f1 ml-0.5 cursor-pointer hover:text-osu-l2 transition-colors"
          title="All players"
        >
          +{overflow}
        </button>
      )}
    </div>
  );
}

// ── Map details modal ──────────────────────────────────────────────────────

type MapDetails =
  | { kind: "farmed"; map: MapsFarmedEntry }
  | { kind: "popular"; map: MapsAggregatedBeatmap }
  | { kind: "favourite"; fav: MapsAggregatedFavourite };

function MapDetailsModal({
  details,
  country,
  onClose,
}: {
  details: MapDetails | null;
  country: string;
  onClose: () => void;
}) {
  const [bodyLockActive, setBodyLockActive] = useState(false);

  useEffect(() => {
    if (!details) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
    };
  }, [details, onClose]);

  // Engage the lock synchronously (before paint) the moment the modal opens, so
  // the scrollbar is already gone and its gutter compensated on the very first
  // frame. Doing this in a post-paint effect let the modal paint once at the
  // pre-lock centre and then jump right as the scrollbar vanished, which read as
  // a slide-in. Unlocking stays deferred to onExitComplete so the page doesn't
  // reflow under the exit animation.
  useLayoutEffect(() => {
    if (details) setBodyLockActive(true);
  }, [details]);

  useLayoutEffect(() => {
    if (!bodyLockActive) return;
    const prevOverflow = document.body.style.overflow;
    const prevPaddingRight = document.body.style.paddingRight;
    const prevScrollbarCompensation = document.documentElement.style.getPropertyValue("--modal-scrollbar-compensation");
    const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;
    const hasStableScrollbarGutter =
      typeof CSS !== "undefined" && CSS.supports?.("scrollbar-gutter", "stable");
    document.body.style.overflow = "hidden";
    if (scrollbarWidth > 0 && !hasStableScrollbarGutter) {
      const currentPaddingRight = parseFloat(window.getComputedStyle(document.body).paddingRight) || 0;
      document.body.style.paddingRight = `${currentPaddingRight + scrollbarWidth}px`;
      document.documentElement.style.setProperty("--modal-scrollbar-compensation", `${scrollbarWidth}px`);
    }
    return () => {
      document.body.style.overflow = prevOverflow;
      document.body.style.paddingRight = prevPaddingRight;
      if (prevScrollbarCompensation) {
        document.documentElement.style.setProperty("--modal-scrollbar-compensation", prevScrollbarCompensation);
      } else {
        document.documentElement.style.removeProperty("--modal-scrollbar-compensation");
      }
    };
  }, [bodyLockActive]);

  if (typeof document === "undefined") return null;

  return createPortal(
    <AnimatePresence onExitComplete={() => setBodyLockActive(false)}>
      {details && (
        <motion.div
          key="map-details"
          className="fixed inset-0 z-[120] flex items-center justify-center py-3 pl-3 sm:py-6 sm:pl-6 pr-[calc(0.75rem+var(--modal-scrollbar-compensation,0px))] sm:pr-[calc(1.5rem+var(--modal-scrollbar-compensation,0px))]"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.12 }}
        >
          <div
            className="absolute inset-0 bg-black/85"
            onClick={onClose}
          />
          <motion.div
            className="modal-card-mobile-safe relative isolate z-10 w-full max-w-[640px] max-h-[calc(100dvh-1.5rem)] sm:max-h-[calc(100dvh-3rem)] overflow-hidden rounded-2xl bg-osu-b5 ring-1 ring-white/10 shadow-2xl flex flex-col"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.12, ease: "easeOut" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="pointer-events-none absolute inset-0 bg-osu-b5" aria-hidden="true" />
            <div className="relative z-10 flex min-h-0 flex-1 flex-col">
              <MapDetailsContent details={details} country={country} onClose={onClose} />
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

function MapDetailsContent({
  details,
  country,
  onClose,
}: {
  details: MapDetails;
  country: string;
  onClose: () => void;
}) {
  const setId =
    details.kind === "favourite" ? details.fav.beatmapsetId : details.map.beatmapsetId;
  const covers = details.kind === "favourite" ? details.fav.covers : details.map.covers;
  const cover = covers.cover ?? covers.card ?? covers["list@2x"] ?? covers.list;
  const title = details.kind === "favourite" ? details.fav.title : details.map.title;
  const artist = details.kind === "favourite" ? details.fav.artist : details.map.artist;
  const creator = details.kind === "favourite" ? details.fav.creator : details.map.creator;
  const status = details.kind === "favourite" ? details.fav.status : details.map.status;
  const beatmapsetUrl =
    details.kind === "favourite"
      ? `https://osu.ppy.sh/beatmapsets/${setId}`
      : `https://osu.ppy.sh/beatmapsets/${setId}#mania/${details.map.beatmapId}`;
  const osuDirectUrl = `osu://dl/${setId}`;
  // The backend computes dominantMod over the full roster; null is a real value
  // ("no dominant mod"), so only recompute from preview players when it's absent.
  const dominantMod =
    details.kind === "farmed"
      ? details.map.dominantMod !== undefined
        ? details.map.dominantMod
        : getDominantSpeedMod(details.map.players)
      : null;
  const dominantModFile =
    dominantMod === "DT" ? "double-time" : dominantMod === "HT" ? "half-time" : null;
  const dominantModColor = dominantMod === "DT" ? "#ff6666" : "#b3d944";

  const keyCount =
    details.kind === "farmed"
      ? details.map.cs
      : details.kind === "popular"
        ? parseKeyCount(details.map.version)
        : null;
  const stars = details.kind !== "favourite" ? details.map.difficultyRating : null;

  const adjustedLength =
    details.kind === "farmed"
      ? Math.round(
          dominantMod === "DT"
            ? details.map.totalLength / 1.5
            : dominantMod === "HT"
              ? details.map.totalLength / 0.75
              : details.map.totalLength,
        )
      : details.kind === "popular"
        ? details.map.totalLength
        : null;
  const bpm = details.kind === "farmed" ? details.map.bpm : null;

  const [decodedCover, setDecodedCover] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setDecodedCover(null);

    const image = new Image();
    image.decoding = "async";
    image.onload = () => {
      const decode = typeof image.decode === "function" ? image.decode() : Promise.resolve();
      decode
        .catch(() => undefined)
        .then(() => {
          if (!cancelled) setDecodedCover(cover);
        });
    };
    image.onerror = () => {
      if (!cancelled) setDecodedCover(cover);
    };
    image.src = cover;

    return () => {
      cancelled = true;
    };
  }, [cover]);
  const coverReady = decodedCover === cover;

  return (
    <>
      <button
        type="button"
        onClick={onClose}
        aria-label="Close"
        className="absolute top-3 right-3 z-30 w-8 h-8 rounded-full bg-black/55 hover:bg-black/85 text-white/90 hover:text-white flex items-center justify-center transition-colors cursor-pointer ring-1 ring-white/15"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>

      <div className="relative z-10 -mb-px h-[190px] shrink-0 overflow-hidden bg-osu-b5 sm:h-[220px]">
        <div
          className={`absolute inset-0 bg-cover bg-center transition-opacity duration-0 ease-out sm:duration-300 ${coverReady ? "opacity-100" : "opacity-0"}`}
          style={coverReady ? { backgroundImage: `url("${cover.replace(/"/g, '\\"')}")` } : undefined}
          aria-hidden="true"
        />
        <div className="absolute inset-0 z-10 bg-gradient-to-t from-osu-b5 via-osu-b5/45 to-black/25" />
        <div className="absolute inset-x-0 top-0 z-20 flex items-start justify-between gap-3 p-4 pr-14">
          <BeatmapStatusBadge status={status} />
          <div className="flex flex-wrap justify-end gap-1.5">
            {keyCount && (
              <span className="inline-flex items-center rounded-full bg-black/70 px-2 py-0.5 text-[10px] font-bold leading-none tabular-nums text-white">
                {keyCount}K
              </span>
            )}
            {stars !== null && <StarRatingBadge stars={stars} />}
          </div>
        </div>
        <div className="absolute inset-x-0 bottom-0 z-20 px-5 pb-5 sm:px-6">
          <div className="text-[10px] text-white/70 truncate uppercase tracking-wide">
            {artist}
          </div>
          <div className="mt-1 text-[23px] sm:text-[28px] font-bold text-white leading-[1.08] line-clamp-2 break-words pr-8 drop-shadow-lg">
            {title}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-white/78">
            <span className="truncate">by <span className="text-white font-semibold">{creator}</span></span>
            {details.kind !== "favourite" && (
              <>
                <span className="text-white/35">·</span>
                <span className="min-w-0 truncate text-white/90">[{details.map.version}]</span>
              </>
            )}
          </div>
        </div>
      </div>

      <div className="shrink-0 border-b border-osu-b3/35 bg-osu-b5 px-5 py-3 sm:px-6">
        <div className="flex flex-wrap items-center gap-1.5">
          {adjustedLength !== null && (
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-osu-b4 ring-1 ring-osu-b3/50 text-[10px] font-semibold text-osu-l2">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="w-2.5 h-2.5 text-osu-f1">
                <circle cx="12" cy="12" r="9" />
                <polyline points="12 7 12 12 15 14" />
              </svg>
              {formatDuration(adjustedLength)}
            </span>
          )}
          {bpm && bpm > 0 && (
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-osu-b4 ring-1 ring-osu-b3/50 text-[10px] font-semibold text-osu-l2">
              <span className="text-osu-f1">♪</span>
              {Math.round(dominantMod === "DT" ? bpm * 1.5 : dominantMod === "HT" ? bpm * 0.75 : bpm)}
              <span className="text-osu-f1 lowercase">bpm</span>
            </span>
          )}
          {dominantModFile && (
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-osu-b4 ring-1 ring-osu-b3/50 text-[10px] font-semibold text-osu-l2">
              <ModGlyph
                file={dominantModFile}
                color={dominantModColor}
                className="h-3 w-3"
                style={{ transform: "scale(1.2)" }}
              />
              dominant {dominantMod}
            </span>
          )}
        </div>
      </div>

      <div className="overflow-y-auto flex-1 min-h-0 bg-osu-b5 px-5 py-4 sm:px-6 space-y-4">
        {details.kind === "farmed" && (
          <FarmedDetails key={`farmed:${details.map.beatmapId}`} entry={details.map} country={country} />
        )}
        {details.kind === "popular" && (
          <PopularDetails key={`popular:${details.map.beatmapId}`} entry={details.map} country={country} />
        )}
        {details.kind === "favourite" && (
          <FavouriteDetails key={`favourite:${details.fav.beatmapsetId}`} entry={details.fav} country={country} />
        )}
      </div>

      <div className="shrink-0 border-t border-osu-b3/40 px-4 py-3 flex items-center gap-2 bg-osu-b4/95">
        <a
          href={beatmapsetUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-osu-b3/70 hover:bg-osu-b3 text-white/85 hover:text-white text-[12px] font-semibold transition-colors cursor-pointer"
          title="Open beatmap page on osu!"
        >
          <span>Beatmap page</span>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-3 h-3" aria-hidden>
            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
            <polyline points="15 3 21 3 21 9" />
            <line x1="10" y1="14" x2="21" y2="3" />
          </svg>
        </a>
        <a
          href={osuDirectUrl}
          className="hidden items-center gap-1.5 px-3 py-2 rounded-lg bg-osu-b3/70 hover:bg-osu-b3 text-white/85 hover:text-white text-[12px] font-semibold transition-colors cursor-pointer sm:inline-flex"
          title="Open in osu! client"
        >
          <OsuLogo className="h-[14px] w-[14px]" />
          <span>Open in osu!</span>
        </a>
      </div>
    </>
  );
}

function StatItem({
  label,
  value,
  accent = "neutral",
}: {
  label: string;
  value: string;
  accent?: "pink" | "blue" | "yellow" | "neutral";
}) {
  const valueColor =
    accent === "pink"
      ? "text-osu-pink"
      : accent === "blue"
        ? "text-osu-blue"
        : accent === "yellow"
          ? "text-osu-yellow"
          : "text-white";
  return (
    <div className="flex-1 px-3 py-2">
      <div className={`text-[17px] font-bold leading-none tabular-nums ${valueColor}`} style={{ fontFamily: "Torus" }}>
        {value}
      </div>
      <div className="mt-1 text-[9px] uppercase tracking-wide text-osu-f1 font-semibold">{label}</div>
    </div>
  );
}

function StatRow({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-xl bg-osu-b4 ring-1 ring-osu-b3/55 flex items-stretch divide-x divide-osu-b3/55">
      {children}
    </div>
  );
}


function PlayerRow({
  rank,
  player,
  sublabel,
  meta,
  onClick,
}: {
  rank?: number;
  player: { id: number; username: string; avatarUrl: string };
  sublabel?: React.ReactNode;
  meta?: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex items-center gap-2.5 w-full px-2.5 py-1.5 rounded-lg hover:bg-osu-b3/60 transition-colors cursor-pointer text-left"
    >
      {rank !== undefined && (
        <span className="w-5 text-center text-[10px] text-osu-f1 tabular-nums">{rank}</span>
      )}
      <Avatar url={player.avatarUrl} size={26} />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="truncate text-[12px] text-osu-l2 transition-colors group-hover:text-white">{player.username}</span>
          {sublabel ? (
            <span className="shrink-0 text-[10px] text-osu-f1/75">{sublabel}</span>
          ) : null}
        </div>
      </div>
      {meta}
    </button>
  );
}

function toFarmedDetailPlayers(players: LiveMapsDetailsPlayer[]): MapsFarmedPlayer[] {
  return players.map((player) => ({
    id: player.id,
    username: player.username,
    avatarUrl: player.avatarUrl,
    mods: player.mods ?? [],
    pp: player.pp ?? 0,
    scoreUrl: player.scoreUrl ?? null,
    playedAt: player.playedAt ?? null,
    rank: player.rank,
  }));
}

function toPopularDetailPlayers(players: LiveMapsDetailsPlayer[]): MapsPlayerEntry[] {
  return players.map((player) => ({
    id: player.id,
    username: player.username,
    avatarUrl: player.avatarUrl,
    count: player.count ?? 0,
    rank: player.rank,
  }));
}

function toFavouriteDetailPlayers(players: LiveMapsDetailsPlayer[]): Array<{ id: number; username: string; avatarUrl: string }> {
  return players.map((player) => ({
    id: player.id,
    username: player.username,
    avatarUrl: player.avatarUrl,
  }));
}

const MAPS_DETAILS_PAGE_SIZE = LIVE_MAPS_PLAYERS_PAGE_SIZE;

interface MapsPlayerListControl {
  query: string;
  setQuery: (value: string) => void;
  matched: number;
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  loadMore: () => void;
}

// Loads a map's player list one page (50) at a time from the server,
// with server-side search, so a 1k+ player map never ships or renders in one
// shot. Only engaged when the map has more players than the preview already
// holds; otherwise the modal searches the preview client-side.
function useMapsDetailsPlayers({
  country,
  kind,
  id,
  enabled,
}: {
  country: string;
  kind: LiveMapsPlayersKind;
  id: number;
  enabled: boolean;
}): { players: LiveMapsDetailsPlayer[]; loadedOnce: boolean; total: number; control: MapsPlayerListControl } {
  const [players, setPlayers] = useState<LiveMapsDetailsPlayer[]>([]);
  const [total, setTotal] = useState(0);
  const [matched, setMatched] = useState(0);
  const [page, setPage] = useState(0);
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  // Bumped on every page-0 reload so an in-flight loadMore from a previous
  // query/page can detect it is stale and drop its (now mismatched) results.
  const requestSeq = useRef(0);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), 250);
    return () => clearTimeout(timer);
  }, [query]);

  // First page + every search change reloads from page 0.
  useEffect(() => {
    if (!enabled) return;
    const seq = ++requestSeq.current;
    setLoading(true);
    fetchLiveMapsPlayersSnapshot(country, kind, id, { page: 0, pageSize: MAPS_DETAILS_PAGE_SIZE, q: debouncedQuery })
      .then((snapshot) => {
        if (requestSeq.current !== seq) return;
        setPlayers(snapshot.players);
        setTotal(snapshot.total);
        setMatched(snapshot.matched);
        setPage(0);
        setLoadedOnce(true);
      })
      .catch(() => {
        if (requestSeq.current === seq) setLoadedOnce(true);
      })
      .finally(() => {
        if (requestSeq.current === seq) setLoading(false);
      });
  }, [enabled, country, kind, id, debouncedQuery]);

  const loadMore = useCallback(() => {
    if (!enabled || loading || loadingMore) return;
    const nextPage = page + 1;
    if (nextPage * MAPS_DETAILS_PAGE_SIZE >= matched) return;
    const seq = requestSeq.current;
    setLoadingMore(true);
    fetchLiveMapsPlayersSnapshot(country, kind, id, { page: nextPage, pageSize: MAPS_DETAILS_PAGE_SIZE, q: debouncedQuery })
      .then((snapshot) => {
        if (requestSeq.current !== seq) return;
        setPlayers((prev) => {
          const seen = new Set(prev.map((player) => player.id));
          return [...prev, ...snapshot.players.filter((player) => !seen.has(player.id))];
        });
        setTotal(snapshot.total);
        setMatched(snapshot.matched);
        setPage(nextPage);
      })
      .catch(() => undefined)
      .finally(() => setLoadingMore(false));
  }, [enabled, loading, loadingMore, page, matched, country, kind, id, debouncedQuery]);

  return {
    players,
    loadedOnce,
    total,
    control: {
      query,
      setQuery,
      matched,
      loading,
      loadingMore,
      hasMore: enabled && (page + 1) * MAPS_DETAILS_PAGE_SIZE < matched,
      loadMore,
    },
  };
}

// A list longer than this defers its first render by one frame (see below) so a
// heavy open does not block the modal appearing. Below it, the cost is small
// enough that rendering inline avoids a needless placeholder flash.
const MODAL_DEFER_ROW_THRESHOLD = 24;

// Placeholder rows shown while the modal's player list defers or loads. Mirrors
// PlayerRow's shape (rank · avatar · name · meta for list mode, avatar · name
// for the favourite grid) so the swap to real rows lands in place. Varied name
// widths keep it from reading as a repeating pattern.
const MAPS_SKELETON_NAME_WIDTHS = ["w-28", "w-20", "w-24", "w-16", "w-28", "w-20", "w-24", "w-16", "w-20"];

function MapsPlayerListSkeleton({ grid = false, count }: { grid?: boolean; count: number }) {
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="flex items-center gap-2.5 px-2.5 py-1.5">
          {!grid && <Skeleton className="h-2.5 w-4 shrink-0" />}
          <Skeleton className="h-[26px] w-[26px] rounded-full shrink-0" />
          <Skeleton className={`h-3 ${MAPS_SKELETON_NAME_WIDTHS[i % MAPS_SKELETON_NAME_WIDTHS.length]}`} />
          {!grid && <Skeleton className="ml-auto h-3.5 w-10 shrink-0" />}
        </div>
      ))}
    </>
  );
}

// Player list for the beatmap detail modal. With a `control` it runs in
// server-paginated mode (50 per request, server-side search, infinite scroll);
// without one it searches the already-loaded preview client-side.
function ModalPlayerList<T extends { id: number; username: string; rank?: number }>({
  title,
  players,
  total,
  control,
  grid = false,
  renderRow,
}: {
  title: string;
  players: T[];
  total: number;
  control?: MapsPlayerListControl;
  grid?: boolean;
  renderRow: (player: T, rank: number) => React.ReactNode;
}) {
  const hiddenUserIds = useHiddenUserIds();
  const serverMode = control != null;
  const [clientQuery, setClientQuery] = useState("");
  const query = serverMode ? control.query : clientQuery;
  const setQuery = serverMode ? control.setQuery : setClientQuery;
  const q = query.trim().toLowerCase();

  const visible = useMemo(
    () => players.filter((player) => !hiddenUserIds.has(player.id)),
    [players, hiddenUserIds],
  );
  // Prefer the server's board rank (set in server-paginated mode) so a searched
  // player keeps its true standing among all players; fall back to list position
  // for client-side mode, where `visible` is the full unfiltered list anyway.
  const rankById = useMemo(
    () => new Map(visible.map((player, i) => [player.id, player.rank ?? i + 1])),
    [visible],
  );
  const rows = useMemo(
    () => (!serverMode && q ? visible.filter((player) => player.username.toLowerCase().includes(q)) : visible),
    [visible, q, serverMode],
  );
  const matched = serverMode ? control.matched : rows.length;

  const scrollRef = useRef<HTMLDivElement>(null);
  const onScroll = useCallback(() => {
    if (!control?.hasMore || control.loadingMore) return;
    const el = scrollRef.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 160) control.loadMore();
  }, [control]);

  // Render the modal shell on the open commit and let a large row list mount on
  // the next frame, so clicking a map feels instant. Lists at or under the
  // threshold start ready and render inline (no placeholder flash).
  const [rowsReady, setRowsReady] = useState(() => rows.length <= MODAL_DEFER_ROW_THRESHOLD);
  useEffect(() => {
    if (rowsReady) return;
    const id = requestAnimationFrame(() => setRowsReady(true));
    return () => cancelAnimationFrame(id);
  }, [rowsReady]);

  // While deferring, or while the server's first page is still loading, hold the
  // scroll area at its full height so the modal opens at its final size and fills
  // in, instead of opening short and growing as rows arrive. Both cases resolve
  // to a list taller than this, so there is no later shrink.
  const reserveSpace = !rowsReady || (serverMode && control.loading && rows.length === 0);

  return (
    <div>
      <div className="flex items-baseline gap-2 mb-1.5 px-1">
        <h3 className="text-[10px] uppercase tracking-wider font-bold text-osu-f1">{title}</h3>
        <span className="text-[10px] text-osu-f1/70 tabular-nums">
          {q ? `${formatNumber(matched)} of ${formatNumber(total)}` : formatNumber(total)}
        </span>
      </div>
      {total > 12 && (
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search player..."
          className="mb-1.5 w-full rounded-lg bg-osu-b4 border border-osu-b3/40 px-3 py-1.5 text-[11px] text-osu-c1 placeholder:text-osu-f1 focus:border-osu-h1/40 focus:outline-none transition-colors"
        />
      )}
      <div
        ref={scrollRef}
        onScroll={serverMode ? onScroll : undefined}
        className={`rounded-xl bg-osu-b4 ring-1 ring-osu-b3/55 p-1 max-h-[280px] overflow-y-auto ${reserveSpace ? "min-h-[280px]" : ""} ${grid ? "grid grid-cols-1 min-[390px]:grid-cols-2 sm:grid-cols-3 gap-1" : ""}`}
      >
        {!rowsReady ? (
          <MapsPlayerListSkeleton grid={grid} count={grid ? 9 : 8} />
        ) : rows.length > 0 ? (
          rows.map((player) => renderRow(player, rankById.get(player.id) ?? 0))
        ) : serverMode && control.loading ? (
          <MapsPlayerListSkeleton grid={grid} count={grid ? 9 : 8} />
        ) : (
          <div className="px-3 py-4 text-center text-[11px] text-osu-f1 col-span-full">No players found</div>
        )}
        {serverMode && control.loadingMore && rows.length > 0 && (
          <MapsPlayerListSkeleton grid={grid} count={grid ? 3 : 2} />
        )}
      </div>
    </div>
  );
}

function FarmedDetails({ entry, country }: { entry: MapsFarmedEntry; country: string }) {
  const enabled = isLiveBackendConfigured() && entry.players.length < entry.playerCount;
  const { players: serverPlayers, loadedOnce, total, control } = useMapsDetailsPlayers({
    country,
    kind: "farmed",
    id: entry.beatmapId,
    enabled,
  });
  // In server-paginated mode the up-to-80 preview is about to be replaced by the
  // backend's first page, so skip rendering it in the modal-open commit; the
  // list shows its loading state until the real (ranked) page lands. Client mode
  // has no fetch coming, so it keeps rendering the full preview it already holds.
  const sortedPlayers = useMemo(
    () =>
      enabled && !loadedOnce
        ? []
        : [...(enabled ? toFarmedDetailPlayers(serverPlayers) : entry.players)].sort((a, b) => b.pp - a.pp),
    [enabled, loadedOnce, serverPlayers, entry.players],
  );
  const totalPlayers = enabled && loadedOnce ? total : entry.playerCount;

  return (
    <>
      <StatRow>
        <StatItem label="players" value={formatNumber(totalPlayers)} accent="blue" />
        <StatItem label="avg pp" value={`~${Math.round(entry.avgPp)}`} accent="pink" />
        <StatItem label="max pp" value={Math.round(entry.maxPp).toString()} accent="pink" />
      </StatRow>

      <ModalPlayerList
        title="Farmed by"
        players={sortedPlayers}
        total={totalPlayers}
        control={enabled ? control : undefined}
        renderRow={(p, rank) => (
          <PlayerRow
            key={p.id}
            rank={rank}
            player={p}
            sublabel={p.playedAt ? formatTimeAgo(p.playedAt) : undefined}
            onClick={() => {
              const url = p.scoreUrl || `https://osu.ppy.sh/users/${p.id}/mania`;
              window.open(url, "_blank", "noopener,noreferrer");
            }}
            meta={
              <div className="flex items-center gap-1.5 flex-shrink-0">
                {p.mods?.length ? (
                  <div className="flex items-center gap-0.5">
                    {p.mods.map((mod) => (
                      <span key={mod} className="inline-flex origin-center scale-[0.42] -mx-1.5">
                        <ModBadge mod={mod} />
                      </span>
                    ))}
                  </div>
                ) : null}
                {p.pp ? (
                  <span className="inline-flex items-baseline gap-0.5 text-osu-pink tabular-nums" style={{ fontFamily: "Torus" }}>
                    <span className="text-[12px] font-bold">{Math.round(p.pp)}</span>
                    <span className="text-[8px] text-osu-pink/70 font-bold uppercase">pp</span>
                  </span>
                ) : null}
              </div>
            }
          />
        )}
      />
    </>
  );
}

function PopularDetails({ entry, country }: { entry: MapsAggregatedBeatmap; country: string }) {
  const enabled = isLiveBackendConfigured() && entry.players.length < entry.playerCount;
  const { players: serverPlayers, loadedOnce, total, control } = useMapsDetailsPlayers({
    country,
    kind: "popular",
    id: entry.beatmapId,
    enabled,
  });
  const sortedPlayers = useMemo(
    () =>
      enabled && !loadedOnce
        ? []
        : [...(enabled ? toPopularDetailPlayers(serverPlayers) : entry.players)].sort((a, b) => b.count - a.count),
    [enabled, loadedOnce, serverPlayers, entry.players],
  );
  const totalPlayers = enabled && loadedOnce ? total : entry.playerCount;

  return (
    <>
      <StatRow>
        <StatItem label="total plays" value={formatNumber(entry.totalPlays)} accent="pink" />
        <StatItem label="players" value={formatNumber(totalPlayers)} accent="blue" />
        <StatItem label="global plays" value={formatNumber(entry.globalPlayCount)} />
      </StatRow>

      <ModalPlayerList
        title="Most played by"
        players={sortedPlayers}
        total={totalPlayers}
        control={enabled ? control : undefined}
        renderRow={(p, rank) => (
          <PlayerRow
            key={p.id}
            rank={rank}
            player={p}
            onClick={() => window.open(`https://osu.ppy.sh/users/${p.id}/mania`, "_blank", "noopener,noreferrer")}
            meta={
              p.count ? (
                <span className="inline-flex items-baseline gap-0.5 text-osu-pink tabular-nums" style={{ fontFamily: "Torus" }}>
                  <span className="text-[12px] font-bold">{formatNumber(p.count)}</span>
                  <span className="text-[8px] text-osu-pink/70 font-bold lowercase">x</span>
                </span>
              ) : null
            }
          />
        )}
      />
    </>
  );
}

function FavouriteDetails({ entry, country }: { entry: MapsAggregatedFavourite; country: string }) {
  const enabled = isLiveBackendConfigured() && entry.players.length < entry.playerCount;
  const { players: serverPlayers, loadedOnce, total, control } = useMapsDetailsPlayers({
    country,
    kind: "favourite",
    id: entry.beatmapsetId,
    enabled,
  });
  const visiblePlayers = enabled ? (loadedOnce ? toFavouriteDetailPlayers(serverPlayers) : []) : entry.players;
  const totalPlayers = enabled && loadedOnce ? total : entry.playerCount;
  return (
    <>
      <StatRow>
        <StatItem label={`${country.toLowerCase()} favs`} value={formatNumber(totalPlayers)} accent="pink" />
        <StatItem label="global favs" value={formatNumber(entry.globalFavouriteCount)} />
        <StatItem label="global plays" value={formatNumber(entry.globalPlayCount)} />
      </StatRow>

      <ModalPlayerList
        title="Favourited by"
        players={visiblePlayers}
        total={totalPlayers}
        control={enabled ? control : undefined}
        grid
        renderRow={(p) => (
          <PlayerRow
            key={p.id}
            player={p}
            onClick={() => window.open(`https://osu.ppy.sh/users/${p.id}/mania`, "_blank", "noopener,noreferrer")}
          />
        )}
      />
    </>
  );
}

// ── Farmed card (from best scores) ─────────────────────────────────────────

function FarmedCard({
  map,
  onPlayerClick,
  onOpenDetails,
}: {
  map: MapsFarmedEntry;
  onPlayerClick: (u: string) => void;
  onOpenDetails: () => void;
}) {
  // dominantMod from the live backend is computed over the full roster; null is a
  // real "no dominant mod" verdict, so only recompute (fallback path) when absent.
  const dominantMod = map.dominantMod !== undefined ? map.dominantMod : getDominantSpeedMod(map.players);
  const dominantModFile = dominantMod === "DT" ? "double-time" : dominantMod === "HT" ? "half-time" : null;
  const dominantModColor = dominantMod === "DT" ? "#ff6666" : "#b3d944";

  return (
    <div className="rounded-xl bg-osu-b4 border border-osu-b3/20 hover:border-osu-pink/30 transition-colors">
      <button
        type="button"
        onClick={onOpenDetails}
        className="block w-full text-left relative rounded-t-xl overflow-hidden cursor-pointer focus:outline-none focus-visible:outline-none"
      >
        <img src={map.covers.card} alt="" className="w-full h-[90px] object-cover" loading="lazy" />
        <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-transparent" />
        {dominantModFile && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none -translate-y-2.5">
            <div className="relative w-[56px] h-[38px] opacity-70">
              {/* Colored badge hexagon */}
              <ModGlyph file="icon" color={dominantModColor} className="absolute inset-0 h-full w-full" />
              {/* Mod glyph */}
              <ModGlyph
                file={dominantModFile}
                color={`color-mix(in srgb-linear, black, ${dominantModColor} 10%)`}
                className="absolute inset-0 h-full w-full"
                style={{ transform: "scale(1.1)" }}
              />
            </div>
          </div>
        )}
        <span className="absolute top-1.5 left-1.5 inline-flex items-center rounded-full bg-black/70 px-2 py-0.5 text-[10px] font-bold leading-none tabular-nums text-white">
          {map.cs}K
        </span>
        <StarRatingBadge stars={map.difficultyRating} className="absolute top-1.5 right-1.5" />
        <div className="absolute bottom-0 left-0 right-0 px-2.5 pb-1.5">
          <div className="text-[12px] font-semibold text-white truncate leading-tight drop-shadow-lg">{map.title}</div>
          <div className="text-[10px] text-white/70 truncate leading-tight drop-shadow-lg">{map.artist}</div>
        </div>
      </button>

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
          totalCount={map.playerCount}
          onMoreClick={onOpenDetails}
          onPlayerClick={(player) => {
            if (player.scoreUrl) {
              window.open(player.scoreUrl, "_blank", "noopener,noreferrer");
              return;
            }
            onPlayerClick(player.username);
          }}
        />
      </div>
    </div>
  );
}

// ── Most Played card (from most_played endpoint) ───────────────────────────

function MostPlayedCard({
  map,
  onPlayerClick,
  onOpenDetails,
}: {
  map: MapsAggregatedBeatmap;
  onPlayerClick: (u: string) => void;
  onOpenDetails: () => void;
}) {
  const kc = parseKeyCount(map.version);

  return (
    <div className="rounded-xl bg-osu-b4 border border-osu-b3/20 hover:border-osu-pink/30 transition-colors">
      <button
        type="button"
        onClick={onOpenDetails}
        className="block w-full text-left relative rounded-t-xl overflow-hidden cursor-pointer focus:outline-none focus-visible:outline-none"
      >
        <img src={map.covers.card} alt="" className="w-full h-[90px] object-cover" loading="lazy" />
        <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-transparent" />
        {kc && (
          <span className="absolute top-1.5 left-1.5 inline-flex items-center rounded-full bg-black/70 px-2 py-0.5 text-[10px] font-bold leading-none tabular-nums text-white">{kc}K</span>
        )}
        <StarRatingBadge stars={map.difficultyRating} className="absolute top-1.5 right-1.5" />
        <div className="absolute bottom-0 left-0 right-0 px-2.5 pb-1.5">
          <div className="text-[12px] font-semibold text-white truncate leading-tight drop-shadow-lg">{map.title}</div>
          <div className="text-[10px] text-white/70 truncate leading-tight drop-shadow-lg">{map.artist}</div>
        </div>
      </button>

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
          totalCount={map.playerCount}
          onMoreClick={onOpenDetails}
          onPlayerClick={(player) => onPlayerClick(player.username)}
        />
      </div>
    </div>
  );
}

// ── Favourite card ─────────────────────────────────────────────────────────

function FavouriteCard({
  fav,
  onPlayerClick,
  onOpenDetails,
}: {
  fav: MapsAggregatedFavourite;
  onPlayerClick: (u: string) => void;
  onOpenDetails: () => void;
}) {
  const selectedCountry = useSelectedCountry();

  return (
    <div className="rounded-xl bg-osu-b4 border border-osu-b3/20 hover:border-osu-pink/30 transition-colors">
      <button
        type="button"
        onClick={onOpenDetails}
        className="block w-full text-left relative rounded-t-xl overflow-hidden cursor-pointer focus:outline-none focus-visible:outline-none"
      >
        <img src={fav.covers.card} alt="" className="w-full h-[90px] object-cover" loading="lazy" />
        <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-transparent" />
        <BeatmapStatusBadge status={fav.status} className="absolute top-1.5 left-1.5" />
        <div className="absolute bottom-0 left-0 right-0 px-2.5 pb-1.5">
          <div className="text-[12px] font-semibold text-white truncate leading-tight drop-shadow-lg">{fav.title}</div>
          <div className="text-[10px] text-white/70 truncate leading-tight drop-shadow-lg">{fav.artist}</div>
        </div>
      </button>

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

        <PlayerAvatars
          players={fav.players}
          totalCount={fav.playerCount}
          onMoreClick={onOpenDetails}
          onPlayerClick={(player) => onPlayerClick(player.username)}
        />
      </div>
    </div>
  );
}

// ── Random card (hero-sized favourite card for the Random tab) ────────────

const PREVIEW_VOLUME_STORAGE_KEY = "mania-hub-preview-volume-v1";
const DEFAULT_PREVIEW_VOLUME = 0.3;
// Mobile browsers can briefly report a low readyState while currentTime is
// already moving; trust recent media-clock progress to avoid startup snaps.
const REPLAY_AUDIO_CLOCK_PROGRESS_EPSILON_SECONDS = 0.003;
const REPLAY_AUDIO_CLOCK_PROGRESS_GRACE_MS = 550;

type ReplayAudioClockSample = {
  seconds: number;
  advancingUntil: number;
};

type ReplayAudioClockAnchor = {
  mediaSeconds: number;
  startedAtMs: number;
  playbackRate: number;
};

function resetReplayAudioClockSample(sampleRef: { current: ReplayAudioClockSample | null }, seconds: number): void {
  sampleRef.current = {
    seconds,
    advancingUntil: 0,
  };
}

function getReplayAudioPlaybackRate(audio: HTMLAudioElement, fallbackRate: number): number {
  const rate = Number.isFinite(audio.playbackRate) && audio.playbackRate > 0
    ? audio.playbackRate
    : fallbackRate;
  return Math.max(0.1, rate);
}

function hasRecentReplayAudioClockProgress(sampleRef: { current: ReplayAudioClockSample | null }, seconds: number): boolean {
  const now = performance.now();
  const previous = sampleRef.current;
  if (!previous || seconds < previous.seconds - 0.05) {
    sampleRef.current = { seconds, advancingUntil: 0 };
    return false;
  }

  const advancingUntil = seconds > previous.seconds + REPLAY_AUDIO_CLOCK_PROGRESS_EPSILON_SECONDS
    ? now + REPLAY_AUDIO_CLOCK_PROGRESS_GRACE_MS
    : previous.advancingUntil;
  sampleRef.current = { seconds, advancingUntil };
  return now <= advancingUntil;
}

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

interface RandomPreviewRendererLike {
  readonly isPlaying: boolean;
  readonly time: number;
  readonly duration: number;
  destroy: () => void;
  pause: () => void;
  play: () => void;
  ready: () => Promise<void>;
  resize: () => void;
  seek: (timeMs: number) => void;
  setPreviewData: (
    frames: ReplayFrame[],
    keyCount: number,
    notes: ManiaNote[],
    options: { od?: number; scrollVelocities?: ManiaScrollVelocity[]; initialCombo?: number },
  ) => void;
  setExternalClock: (cb: (() => { time: number; stalled: boolean } | null) | null) => void;
  setSkinSettings: (settings: ReplaySkinSettings) => void;
  setScrollSpeed: (value: number) => void;
}

// Draggable timeline for the chart preview. The handle follows playback, and
// releasing it anywhere jumps the preview to that point in the map.
function ChartPreviewTimeline({
  positionMs,
  lengthMs,
  onSeek,
}: {
  positionMs: number;
  lengthMs: number;
  onSeek: (targetMs: number) => void;
}) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  // Leave a small tail so a scrub never lands right on the final note.
  const maxStartMs = Math.max(0, lengthMs - 2_000);
  const [dragMs, setDragMs] = useState<number | null>(null);
  const activeMs = dragMs ?? Math.min(positionMs, maxStartMs);
  const ratio = maxStartMs > 0 ? Math.min(1, Math.max(0, activeMs / maxStartMs)) : 0;

  const msFromClientX = useCallback((clientX: number) => {
    const track = trackRef.current;
    if (!track) return 0;
    const rect = track.getBoundingClientRect();
    const r = rect.width > 0 ? Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)) : 0;
    return r * maxStartMs;
  }, [maxStartMs]);

  const handlePointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragMs(msFromClientX(e.clientX));
  }, [msFromClientX]);

  const handlePointerMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (dragMs == null) return;
    setDragMs(msFromClientX(e.clientX));
  }, [dragMs, msFromClientX]);

  const handlePointerUp = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (dragMs == null) return;
    const target = msFromClientX(e.clientX);
    setDragMs(null);
    onSeek(target);
  }, [dragMs, msFromClientX, onSeek]);

  const dragging = dragMs != null;

  return (
    <div className="group flex items-center gap-2">
      <span className="text-[9px] tabular-nums text-osu-f1/60 shrink-0">
        {formatDuration(Math.floor(activeMs / 1000))}
      </span>
      <div
        ref={trackRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={() => setDragMs(null)}
        className="relative flex h-3 flex-1 items-center cursor-pointer touch-none select-none"
      >
        <div className="absolute inset-x-0 h-px rounded-full bg-osu-f1/20" />
        <div
          className={`absolute left-0 h-px rounded-full transition-colors ${dragging ? "bg-osu-pink/70" : "bg-osu-f1/40 group-hover:bg-osu-pink/60"}`}
          style={{ width: `${ratio * 100}%` }}
        />
        <div
          className={`absolute h-1.5 w-1.5 -translate-x-1/2 rounded-full transition-all ${dragging ? "scale-125 bg-osu-pink" : "bg-osu-f1/70 group-hover:bg-osu-pink"}`}
          style={{ left: `${ratio * 100}%` }}
        />
      </div>
      <span className="text-[9px] tabular-nums text-osu-f1/60 shrink-0">
        {formatDuration(Math.floor(lengthMs / 1000))}
      </span>
    </div>
  );
}

// Canvas fill for the audio-preview progress bar: the played portion is a
// travelling wave whose amplitude at each x follows a live frequency band of
// the signal (Web Audio analyser over the CORS-clean proxied clip), driven by
// spectral flux so it dances to onsets rather than sustained loudness - see
// the inline notes on the band pipeline below. When the analyser is
// unavailable (no live backend, or the direct b.ppy.sh fallback, which is
// tainted) the level degrades to a BPM-phase envelope: set previews start at
// the map's preview point, which mappers snap to the beat, so beat zero is
// simply clip start. Everything draws per frame off the media clock -
// timeupdate alone ticks ~4Hz.
function BeatWaveFill({
  getAudio,
  bpm,
  maxSeconds,
  analysable,
}: {
  getAudio: () => HTMLAudioElement | null;
  bpm: number;
  maxSeconds: number;
  analysable: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const reduceMotion = typeof window.matchMedia === "function"
      && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    // The osu-pink runtime color: the --color-osu-* vars are build-time only.
    const rootStyle = window.getComputedStyle(document.documentElement);
    const themeHue = Number.parseFloat(rootStyle.getPropertyValue("--theme-hue"));
    const themeSat = Number.parseFloat(rootStyle.getPropertyValue("--theme-sat"));
    const waveColor = `hsl(${Number.isFinite(themeHue) ? themeHue : 333}, ${Math.round((Number.isFinite(themeSat) ? themeSat : 1) * 100)}%, 70%)`;
    // Fold frantic BPMs to their half-time feel so the fallback pulse and the
    // wave travel stay readable instead of strobing.
    let pulseBpm = bpm;
    while (pulseBpm > 220) pulseBpm /= 2;
    const beatSeconds = pulseBpm > 0 ? 60 / pulseBpm : 0;

    // Only record the size here; the draw loop syncs the bitmap right before
    // it repaints (see below for why).
    let width = 0;
    let height = 0;
    const measure = (rect: { width: number; height: number }) => {
      width = rect.width;
      height = rect.height;
    };
    measure(canvas.getBoundingClientRect());
    const observer = new ResizeObserver((entries) => {
      const rect = entries[entries.length - 1]?.contentRect;
      if (rect) measure(rect);
    });
    observer.observe(canvas);

    let raf = 0;
    let analyser: AnalyserNode | null = null;
    let analyserFailed = false;
    let bins: Uint8Array<ArrayBuffer> | null = null;
    // Spectrum ribbon: position along the bar maps to frequency (log-spaced
    // 40Hz-8kHz, bass left, highs right), so different parts of the bar move
    // with different parts of the mix - kicks pump the left, melody works the
    // middle, hats shimmer the right. (A single loudness scalar moving every
    // x in unison read as BPM decoration rather than the audio.)
    const BANDS = 24;
    const bandLevels = new Float32Array(BANDS);
    const bandValues = new Float32Array(BANDS);
    const bandFlux = new Float32Array(BANDS);
    const prevValues = new Float32Array(BANDS);
    let bandRanges: Array<[number, number]> | null = null;
    // One GLOBAL loudness reference, deliberately not per-band auto-gain:
    // normalising each band against its own peak makes every band ride near
    // its own max, so a mellow song wiggles exactly like a banger. A single
    // reference (plus a fixed treble tilt below) preserves both the spectral
    // shape and the song's actual dynamics.
    let globalPeak = 0.06;
    // Movement is driven by spectral flux (per-band frame-to-frame increase),
    // not magnitude: a sustained wall of sound measures loud in every band
    // yet has no rhythm to it, and magnitude-driven bars dance through it
    // (measured: a shoegaze preview pinned a magnitude drive at 1.0 while a
    // punchy DnB track sat at 0.5). Onsets - kicks, snares, note changes -
    // are what should move the wave.
    let fluxPeak = 0.04;
    // Pulse level for the no-analyser fallback.
    let level = 0;
    // Carrier phase, advanced with media time scaled by the music's energy:
    // calm passages barely drift, hits push the wave forward. Pausing stops
    // it for free because media time stops.
    let phase = 0;
    let lastMediaT = -1;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const audio = getAudio();
      if (!audio) return;
      const t = Math.min(audio.currentTime, maxSeconds);
      const progressX = maxSeconds > 0 ? Math.min(1, t / maxSeconds) * width : 0;

      const active = !audio.paused && !reduceMotion;
      if (active && analysable && !analyser && !analyserFailed) {
        analyser = getPreviewAnalyser(audio);
        analyserFailed = analyser == null;
      }
      if (analyser && active) {
        if (!bins || bins.length !== analyser.frequencyBinCount) {
          bins = new Uint8Array(analyser.frequencyBinCount);
          bandRanges = null;
        }
        analyser.getByteFrequencyData(bins);
        if (!bandRanges) {
          const binHz = analyser.context.sampleRate / 2 / bins.length;
          const maxHz = Math.min(8000, analyser.context.sampleRate / 2);
          bandRanges = [];
          for (let b = 0; b < BANDS; b += 1) {
            const f0 = 40 * Math.pow(maxHz / 40, b / BANDS);
            const f1 = 40 * Math.pow(maxHz / 40, (b + 1) / BANDS);
            const i0 = Math.min(bins.length - 1, Math.max(1, Math.floor(f0 / binHz)));
            const i1 = Math.min(bins.length, Math.max(i0 + 1, Math.ceil(f1 / binHz)));
            bandRanges.push([i0, i1]);
          }
        }
        let frameMax = 0;
        let frameFluxMax = 0;
        for (let b = 0; b < BANDS; b += 1) {
          const [i0, i1] = bandRanges[b];
          let sum = 0;
          for (let i = i0; i < i1; i += 1) sum += bins[i];
          // The tilt is a fixed compensation for the natural treble roll-off
          // of music, so highs register without giving them infinite gain.
          const value = (sum / (i1 - i0) / 255) * (1 + 1.8 * (b / (BANDS - 1)));
          bandValues[b] = value;
          if (value > frameMax) frameMax = value;
          const flux = Math.max(0, value - prevValues[b]);
          prevValues[b] = value;
          bandFlux[b] = flux;
          if (flux > frameFluxMax) frameFluxMax = flux;
        }
        globalPeak = Math.max(frameMax, globalPeak * 0.998, 0.06);
        fluxPeak = Math.max(frameFluxMax, fluxPeak * 0.998, 0.04);
        for (let b = 0; b < BANDS; b += 1) {
          // The 1.6 power deepens valleys: content well below the mix's
          // loudest register stays visibly small.
          const magNorm = Math.pow(Math.min(1, bandValues[b] / globalPeak), 1.6);
          const fluxNorm = Math.min(1, bandFlux[b] / fluxPeak);
          // Onsets dominate; sustained content keeps only a low hum so the
          // bar isn't dead through held chords, but doesn't dance to them.
          const targetB = Math.max(0.18 * magNorm, fluxNorm);
          // Fast attack, slower release: a hit snaps up and rings briefly.
          bandLevels[b] += (targetB - bandLevels[b]) * (targetB > bandLevels[b] ? 0.7 : 0.12);
        }
      } else {
        // Paused (frequency data freezes on a paused element) or no analyser:
        // settle the ribbon; the BPM-phase fallback pulses `level` instead.
        for (let b = 0; b < BANDS; b += 1) bandLevels[b] *= 0.85;
        const target = active && !analyser && beatSeconds > 0
          ? Math.exp(-5 * ((t % beatSeconds) / beatSeconds))
          : 0;
        level += (target - level) * (target > level ? 0.6 : 0.18);
      }

      let drive = level;
      if (analyser) {
        let sum = 0;
        for (let b = 0; b < BANDS; b += 1) sum += bandLevels[b];
        drive = Math.min(1, (sum / BANDS) * 1.6);
      }
      const omega = beatSeconds > 0 ? (Math.PI * 2) / beatSeconds : Math.PI * 2;
      if (lastMediaT >= 0 && t > lastMediaT) {
        phase += (t - lastMediaT) * omega * (0.2 + 0.8 * drive);
      }
      lastMediaT = t;

      // Sync the bitmap to the observed size here, in the same frame as the
      // redraw: resizing a canvas blanks it, so doing this in the observer
      // callback flashed an empty bar for one frame on any layout jitter.
      const dpr = window.devicePixelRatio || 1;
      const bitmapWidth = Math.max(1, Math.round(width * dpr));
      const bitmapHeight = Math.max(1, Math.round(height * dpr));
      if (canvas.width !== bitmapWidth || canvas.height !== bitmapHeight) {
        canvas.width = bitmapWidth;
        canvas.height = bitmapHeight;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      }

      ctx.clearRect(0, 0, width, height);
      if (progressX <= 0) return;
      const mid = height / 2;
      const maxAmp = mid - 2.4;
      // The envelope along x is the live spectrum curve (frequency identity
      // is fixed to the full bar width, so a position always answers to the
      // same register); `phase` above makes the carrier march with the
      // music's energy rather than metronomically.
      ctx.strokeStyle = waveColor;
      ctx.fillStyle = waveColor;
      ctx.lineWidth = 2.5;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      for (let x = 0; x <= progressX; x += 2) {
        const taper = Math.max(0, Math.min(1, x / 10, (progressX - x) / 12));
        let local = level;
        if (analyser) {
          const pos = (x / Math.max(1, width)) * (BANDS - 1);
          const b0 = Math.floor(pos);
          const b1 = Math.min(BANDS - 1, b0 + 1);
          local = bandLevels[b0] + (bandLevels[b1] - bandLevels[b0]) * (pos - b0);
        }
        // No unconditional floor: quiet music gets a quiet bar. The tiny
        // energy-scaled base just avoids a dead-flat line mid-song.
        const swell = active ? Math.max(local, 0.05 * drive) : local;
        const y = mid + maxAmp * swell * taper * Math.sin((x / 26) * Math.PI * 2 - phase);
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.lineTo(progressX, mid);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(progressX, mid, 2.4, 0, Math.PI * 2);
      ctx.fill();
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
    };
  }, [analysable, bpm, getAudio, maxSeconds]);

  return (
    <canvas
      ref={canvasRef}
      className="pointer-events-none absolute inset-x-0 top-1/2 h-4 w-full -translate-y-1/2"
      aria-hidden="true"
    />
  );
}

function RandomReplayPreview({
  beatmap,
  startTimeMs,
  timeScale,
  windowMs,
  isPlaying,
  resetWhenIdle,
  getClock,
  onReady,
  onEnded,
}: {
  beatmap: ManiaBeatmap | null;
  startTimeMs: number;
  timeScale: number;
  windowMs: number;
  isPlaying: boolean;
  resetWhenIdle: boolean;
  getClock: () => { time: number; stalled: boolean } | null;
  onReady: () => void;
  onEnded: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<RandomPreviewRendererLike | null>(null);
  const isPlayingRef = useRef(isPlaying);
  const getClockRef = useRef(getClock);
  const scrollSpeedRef = useRef(readReplayScrollSpeed());
  const [scrollSpeed, setScrollSpeed] = useState(readReplayScrollSpeed);
  const [skinSettings, setSkinSettings] = useState(readReplaySkinSettings);
  const [canvasReady, setCanvasReady] = useState(false);
  const initialCombo = useMemo(() => beatmap ? getPreviewInitialCombo(beatmap, startTimeMs) : 0, [beatmap, startTimeMs]);
  const notes = useMemo(() => beatmap ? getPreviewNotes(beatmap, startTimeMs, timeScale, windowMs) : [], [beatmap, startTimeMs, timeScale, windowMs]);
  const scrollVelocities = useMemo(() => beatmap ? getPreviewScrollVelocities(beatmap, startTimeMs, timeScale, windowMs) : [], [beatmap, startTimeMs, timeScale, windowMs]);
  const frames = useMemo(() => beatmap ? buildAutoplayFrames(notes, beatmap.keyCount, windowMs) : [], [beatmap, notes, windowMs]);

  useEffect(() => {
    isPlayingRef.current = isPlaying;
  }, [isPlaying]);

  useEffect(() => {
    getClockRef.current = getClock;
  }, [getClock]);

  useEffect(() => {
    const refreshSharedReplaySettings = () => {
      setScrollSpeed(readReplayScrollSpeed());
      setSkinSettings(readReplaySkinSettings());
    };
    window.addEventListener("storage", refreshSharedReplaySettings);
    window.addEventListener(REPLAY_SCROLL_SPEED_CHANGE_EVENT, refreshSharedReplaySettings);
    window.addEventListener(REPLAY_SKIN_SETTINGS_CHANGE_EVENT, refreshSharedReplaySettings);
    window.addEventListener("focus", refreshSharedReplaySettings);
    return () => {
      window.removeEventListener("storage", refreshSharedReplaySettings);
      window.removeEventListener(REPLAY_SCROLL_SPEED_CHANGE_EVENT, refreshSharedReplaySettings);
      window.removeEventListener(REPLAY_SKIN_SETTINGS_CHANGE_EVENT, refreshSharedReplaySettings);
      window.removeEventListener("focus", refreshSharedReplaySettings);
    };
  }, []);

  useEffect(() => {
    scrollSpeedRef.current = scrollSpeed;
    rendererRef.current?.setScrollSpeed(scrollSpeed);
  }, [scrollSpeed]);

  useEffect(() => {
    rendererRef.current?.setSkinSettings(skinSettings);
  }, [skinSettings]);

  useEffect(() => {
    if (!canvasRef.current || !beatmap) return;

    let cancelled = false;
    let renderer: RandomPreviewRendererLike | null = null;
    let handleResize: (() => void) | null = null;
    setCanvasReady(false);

    void import("../components/replay/ReplayCanvas").then(({ ManiaReplayRenderer }) => {
      if (cancelled || !canvasRef.current) return;
      renderer = new ManiaReplayRenderer(
        canvasRef.current,
        frames,
        beatmap.keyCount,
        notes,
        {
          od: beatmap.od,
          showInputOverlay: false,
          transparentBackground: true,
          hideHud: true,
          showCombo: true,
          initialCombo,
          barePlayfield: true,
          showHealthBar: false,
          scrollVelocities,
          skinSettings,
        },
      ) as RandomPreviewRendererLike;
      renderer.setScrollSpeed(scrollSpeedRef.current);
      renderer.setSkinSettings(skinSettings);
      renderer.setExternalClock(() => getClockRef.current());
      rendererRef.current = renderer;
      handleResize = () => renderer?.resize();
      window.addEventListener("resize", handleResize);
      void renderer.ready().then(() => {
        if (cancelled || rendererRef.current !== renderer) return;
        setCanvasReady(true);
        onReady();
        const activeRenderer = rendererRef.current;
        if (isPlayingRef.current) activeRenderer?.play();
      });
    });

    return () => {
      cancelled = true;
      if (handleResize) window.removeEventListener("resize", handleResize);
      rendererRef.current?.destroy();
      rendererRef.current = null;
    };
  }, [beatmap]);

  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer || !beatmap) return;
    renderer.setPreviewData(frames, beatmap.keyCount, notes, {
      od: beatmap.od,
      scrollVelocities,
      initialCombo,
    });
    if (canvasReady) onReady();
  }, [beatmap, canvasReady, frames, initialCombo, notes, onReady, scrollVelocities]);

  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    if (isPlaying) renderer.play();
    else renderer.pause();
  }, [isPlaying]);

  useEffect(() => {
    if (!isPlaying && resetWhenIdle) rendererRef.current?.seek(0);
  }, [beatmap, isPlaying, resetWhenIdle]);

  useEffect(() => {
    if (!isPlaying) return;
    const id = setInterval(() => {
      const renderer = rendererRef.current;
      if (!renderer) return;
      if (!renderer.isPlaying || renderer.time >= renderer.duration) onEnded();
    }, 50);
    return () => clearInterval(id);
  }, [isPlaying, onEnded]);

  return (
    <div className="absolute inset-0">
      <canvas
        ref={canvasRef}
        className={`relative z-10 h-full w-full transition-opacity duration-75 ${canvasReady ? "opacity-100" : "opacity-0"}`}
      />
    </div>
  );
}

function DifficultyPicker({
  beatmaps,
  selectedId,
  onChange,
}: {
  beatmaps: NonNullable<MapsFavouriteBeatmapset["maniaBeatmaps"]>;
  selectedId: number | null;
  onChange: (id: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  const selected = beatmaps.find((m) => m.id === selectedId) ?? beatmaps[0];
  if (!selected) return null;

  return (
    <div className="relative min-w-0 flex-1" ref={containerRef}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={`flex h-8 w-full items-center justify-between gap-2 rounded-md border py-1 pl-3 pr-2 text-[11px] font-semibold outline-none transition-all cursor-pointer ${
          open
            ? "border-osu-pink/50 bg-osu-pink/10 text-white"
            : "border-osu-b3/70 bg-osu-b5/70 text-osu-l2 hover:border-osu-pink/40 hover:bg-osu-b4 hover:text-white"
        }`}
      >
        <span className="truncate flex items-center gap-1.5">
          <span className="text-osu-f1">{Math.round(selected.cs)}K</span>
          <span className="text-osu-yellow">{"\u2605"}{selected.difficultyRating.toFixed(2)}</span>
          <span className="opacity-80 text-osu-f1">·</span>
          <span className="truncate">{selected.version}</span>
        </span>
        <svg
          viewBox="0 0 20 20"
          fill="currentColor"
          className={`h-4 w-4 shrink-0 transition-transform duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)] ${open ? "rotate-180 text-osu-pink-light" : "text-osu-f1"}`}
          aria-hidden
        >
          <path d="M5.25 7.5 10 12.25 14.75 7.5H5.25Z" />
        </svg>
      </button>

      <div
        className={`absolute left-0 right-0 top-full mt-1.5 z-50 overflow-hidden rounded-lg border border-osu-pink/20 bg-osu-b4/95 shadow-xl shadow-black/40 backdrop-blur-md transition-all duration-200 origin-top ${
          open ? "opacity-100 scale-y-100 translate-y-0 pointer-events-auto" : "opacity-0 scale-y-95 -translate-y-1 pointer-events-none"
        }`}
      >
        <div className="max-h-[220px] overflow-y-auto p-1">
          {beatmaps.map((map) => {
            const isSelected = selectedId === map.id;
            return (
              <button
                key={map.id}
                type="button"
                onClick={() => {
                  onChange(map.id);
                  setOpen(false);
                }}
                className={`flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-[11px] font-semibold transition-all cursor-pointer ${
                  isSelected
                    ? "bg-osu-pink/15 text-osu-pink-light"
                    : "text-osu-l2 hover:bg-osu-b3 hover:text-white"
                }`}
                role="option"
                aria-selected={isSelected}
              >
                <span className={`flex h-3 w-3 shrink-0 items-center justify-center transition-all ${isSelected ? 'opacity-100' : 'opacity-0 scale-75'}`}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="h-3 w-3 text-osu-pink">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                </span>
                <span className="text-osu-f1 w-[20px]">{Math.round(map.cs)}K</span>
                <span className="text-osu-yellow w-[36px]">{"\u2605"}{map.difficultyRating.toFixed(2)}</span>
                <span className="truncate flex-1">{map.version}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function RandomCard({ bm }: { bm: MapsFavouriteBeatmapset }) {
  const url = `https://osu.ppy.sh/beatmapsets/${bm.id}`;
  const coverUrl = bm.covers.cover ?? bm.covers.card ?? bm.covers["list@2x"] ?? bm.covers.list ?? "";
  const keys = bm.maniaKeys ?? [];
  const patterns = (bm.patterns ?? []).slice(0, 5);
  const starLabel = formatStars(bm);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const replayAudioRef = useRef<HTMLAudioElement | null>(null);
  const replayAudioStartSecondsRef = useRef(0);
  const replayAudioStartPendingRef = useRef(false);
  const replayAudioReadyRef = useRef(false);
  const replayAudioClockSampleRef = useRef<ReplayAudioClockSample | null>(null);
  const replayAudioClockAnchorRef = useRef<ReplayAudioClockAnchor | null>(null);
  const previewPlaybackTokenRef = useRef(0);
  const replayPlaybackTokenRef = useRef(0);
  const isRandomCardMountedRef = useRef(true);
  const replayPreviewEndTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestedAudioModeRef = useRef<"audio" | "replay" | null>(null);
  const [isPreviewPlaying, setIsPreviewPlaying] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState<number>(readStoredPreviewVolume);
  const lastNonZeroVolumeRef = useRef<number>(volume > 0 ? volume : DEFAULT_PREVIEW_VOLUME);
  const rawPreviewUrl = typeof bm.previewUrl === "string" ? bm.previewUrl : "";
  const previewUrl = rawPreviewUrl.startsWith("//") ? `https:${rawPreviewUrl}` : rawPreviewUrl;
  // Prefer the live-backend preview proxy: it is the only CORS-clean source
  // the Web Audio analyser (beat wave bar) can read. Direct b.ppy.sh stays as
  // the no-analyser fallback if the proxy errors (e.g. an older backend).
  const previewProxyUrl = previewUrl ? getPreviewAudioProxyUrl(bm.id) : null;
  const [previewProxyFailed, setPreviewProxyFailed] = useState(false);
  const usePreviewProxy = previewProxyUrl != null && !previewProxyFailed;
  const effectivePreviewUrl = usePreviewProxy ? previewProxyUrl : previewUrl;
  const retryPreviewAfterProxyFailRef = useRef(false);
  const maniaBeatmaps = useMemo(
    () => [...(bm.maniaBeatmaps ?? [])].sort((a, b) => b.difficultyRating - a.difficultyRating),
    [bm.maniaBeatmaps],
  );
  const usesSetPreviewForReplayAudio = useMemo(
    () => shouldUseSetPreviewForReplayAudio(bm.title, maniaBeatmaps),
    [bm.title, maniaBeatmaps],
  );
  const [selectedBeatmapId, setSelectedBeatmapId] = useState<number | null>(() => getDefaultRandomBeatmapId(maniaBeatmaps));
  const selectedBeatmap = maniaBeatmaps.find((map) => map.id === selectedBeatmapId) ?? maniaBeatmaps[0] ?? null;
  const selectedDifficultyRate = parseSelectedDifficultyRate(selectedBeatmap, maniaBeatmaps.filter((beatmap) => beatmap.difficultyRating >= 0.5));
  const mapMetadata = [
    bm.bpm > 0 ? `${Math.round(bm.bpm)} BPM` : null,
    selectedBeatmap && selectedBeatmap.totalLength > 0 ? formatDuration(selectedBeatmap.totalLength) : null,
  ].filter((part): part is string => Boolean(part));
  const [previewBeatmap, setPreviewBeatmap] = useState<ManiaBeatmap | null>(null);
  const metadataBeatmapsetId = selectedBeatmap?.beatmapsetId ?? bm.id;
  const audioBeatmapsetId = previewBeatmap?.beatmapsetId ?? metadataBeatmapsetId;
  const [replayChartStartMs, setReplayChartStartMs] = useState(0);
  const [replayChartPlaybackMs, setReplayChartPlaybackMs] = useState(0);
  const [replayChartTimeScale, setReplayChartTimeScale] = useState(1);
  const [replayAudioMode, setReplayAudioMode] = useState<"set-preview" | "selected-file">("set-preview");
  // When the user scrubs the chart preview to a custom point we pin the start
  // offset here; null means "use whatever getChartPreviewPlaybackPlan picked".
  // The nonce lets re-scrubbing the same spot still re-trigger the plan effect.
  const [replayChartScrub, setReplayChartScrub] = useState<{ ms: number; nonce: number } | null>(null);
  const [replayPreviewRequested, setReplayPreviewRequested] = useState(false);
  const [isReplayPreviewPlaying, setIsReplayPreviewPlaying] = useState(false);
  const [isReplayPreviewEnding, setIsReplayPreviewEnding] = useState(false);
  const [isReplayPreviewReady, setIsReplayPreviewReady] = useState(false);
  const [replayPreviewLoading, setReplayPreviewLoading] = useState(false);
  const [replayAudioLoading, setReplayAudioLoading] = useState(false);
  const [replayAudioSizeBytes, setReplayAudioSizeBytes] = useState<number | null>(null);
  const [replayPreviewError, setReplayPreviewError] = useState<string | null>(null);
  const replayAudioFullUrl = previewBeatmap?.audioFilename
    ? getBeatmapAudioUrl(audioBeatmapsetId, previewBeatmap.audioFilename)
    : null;
  const replayAudioPlaybackRate = replayAudioMode === "set-preview" ? selectedDifficultyRate : 1;
  const replayClockRateDivisor = replayAudioMode === "set-preview" ? selectedDifficultyRate : 1;
  const replayPreviewKeyCount = previewBeatmap?.keyCount ?? Math.round(selectedBeatmap?.cs ?? 0);
  const replayPreviewWidth = replayPreviewKeyCount >= 7
    ? 460
    : replayPreviewKeyCount >= 6
    ? 390
    : 300;
  const replayPreviewGap = replayPreviewKeyCount >= 5 ? 24 : 48;
  const replayPreviewTopBleed = 52;
  // Total mapped length, used to bound the scrub timeline. The last note's
  // endTime is a good proxy for chart length without parsing audio metadata.
  const replayChartLengthMs = useMemo(() => {
    if (!previewBeatmap?.notes.length) return 0;
    let end = 0;
    for (const note of previewBeatmap.notes) {
      if (note.endTime > end) end = note.endTime;
    }
    return end;
  }, [previewBeatmap]);
  // The chart preview plays continuously from its start point: notes flow until
  // the chart (or audio) ends rather than being clipped to a fixed window. The
  // set-preview snippet is short and ends on its own, so the window there only
  // needs to comfortably outlast the snippet, not span a multi-minute chart.
  const SET_PREVIEW_WINDOW_MS = 40_000;
  const replayPreviewWindowMs = replayAudioMode === "set-preview"
    ? Math.min(SET_PREVIEW_WINDOW_MS, Math.max(RANDOM_REPLAY_PREVIEW_MS, replayChartLengthMs))
    : Math.max(
      RANDOM_REPLAY_PREVIEW_MS,
      replayChartLengthMs > 0 ? replayChartLengthMs - replayChartStartMs : RANDOM_REPLAY_PREVIEW_MS,
    );
  const replayAudioUrl = replayAudioMode === "set-preview"
    ? effectivePreviewUrl
    : replayAudioFullUrl;
  const replayPreviewStartSeconds = replayAudioMode === "selected-file"
    ? Math.max(0, replayChartStartMs / 1000)
    : 0;
  // Scrubbing needs the full beatmap audio file (the short set-preview snippet
  // always plays from 0). seekChartPreview forces selected-file mode, but the
  // timeline must be reachable even before the first scrub, so it only depends
  // on the chart being longer than the fixed preview window. Without an audio
  // file to fall back to, scrubbed audio can't follow, so require one.
  const canScrubChartPreview = replayChartLengthMs > RANDOM_REPLAY_PREVIEW_MS
    && (replayAudioMode === "selected-file" || Boolean(previewBeatmap?.audioFilename));

  // Some beatmapsets have no background image — the cover URL 404s. Track load
  // failure per URL so a late metadata refresh cannot hide an already-loaded cover.
  // The card remounts on every reroll, so a freshly rendered <img> whose cover
  // is already in the browser cache can finish loading before React attaches its
  // onLoad handler (load/error don't bubble, so there's no delegation to catch
  // it) - the cover then stays hidden and the dark fallback shows on top of an
  // image that actually loaded. Preload through a detached Image() whose handlers
  // are wired up before src, which is immune to that race (same approach the map
  // modal uses).
  const [decodedCover, setDecodedCover] = useState<string | null>(null);
  useEffect(() => {
    if (coverUrl === "") {
      setDecodedCover(null);
      return;
    }
    let cancelled = false;
    setDecodedCover(null);

    const image = new Image();
    image.decoding = "async";
    image.onload = () => {
      const decode = typeof image.decode === "function" ? image.decode() : Promise.resolve();
      decode
        .catch(() => undefined)
        .then(() => {
          if (!cancelled) setDecodedCover(coverUrl);
        });
    };
    image.onerror = () => {
      if (!cancelled) setDecodedCover(coverUrl);
    };
    image.src = coverUrl;

    return () => {
      cancelled = true;
    };
  }, [coverUrl]);
  const coverReady = coverUrl !== "" && decodedCover === coverUrl;

  useEffect(() => {
    previewPlaybackTokenRef.current += 1;
    replayPlaybackTokenRef.current += 1;
    resetAudioElement(audioRef.current);
    resetAudioElement(replayAudioRef.current);
    setSelectedBeatmapId(getDefaultRandomBeatmapId(maniaBeatmaps));
    setReplayPreviewRequested(false);
    setIsReplayPreviewPlaying(false);
    setIsReplayPreviewEnding(false);
    setIsReplayPreviewReady(false);
    setReplayAudioLoading(false);
    setReplayAudioSizeBytes(null);
    setIsPreviewPlaying(false);
    setCurrentTime(0);
    setPreviewBeatmap(null);
    setReplayChartStartMs(0);
    setReplayChartPlaybackMs(0);
    setReplayChartTimeScale(1);
    setReplayAudioMode("set-preview");
    setReplayChartScrub(null);
    replayAudioStartPendingRef.current = false;
    replayAudioReadyRef.current = false;
    replayAudioClockSampleRef.current = null;
    replayAudioClockAnchorRef.current = null;
    replayAudioStartSecondsRef.current = 0;
    requestedAudioModeRef.current = null;
  }, [metadataBeatmapsetId, maniaBeatmaps]);

  useEffect(() => {
    if (!selectedBeatmap || !replayPreviewRequested) {
      setPreviewBeatmap(null);
      setReplayChartStartMs(0);
      setReplayChartPlaybackMs(0);
      setReplayChartTimeScale(1);
      setReplayAudioMode("set-preview");
      setIsReplayPreviewReady(false);
      replayAudioReadyRef.current = false;
      replayAudioClockSampleRef.current = null;
      replayAudioClockAnchorRef.current = null;
      return;
    }

    let cancelled = false;
    setReplayPreviewLoading(true);
    setIsReplayPreviewPlaying(false);
    setIsReplayPreviewReady(false);
    replayAudioClockSampleRef.current = null;
    replayAudioClockAnchorRef.current = null;
    setReplayAudioLoading(false);
    setReplayAudioSizeBytes(null);
    setReplayPreviewError(null);
    const referenceBeatmap = usesSetPreviewForReplayAudio ? getSetPreviewReferenceBeatmap(maniaBeatmaps) : null;
    const referenceBeatmapId = referenceBeatmap?.id && referenceBeatmap.id !== selectedBeatmap.id ? referenceBeatmap.id : null;
    Promise.all([
      getBeatmapFileWithRetry(selectedBeatmap.id, metadataBeatmapsetId),
      referenceBeatmapId ? getBeatmapFileWithRetry(referenceBeatmapId, metadataBeatmapsetId).catch(() => null) : Promise.resolve(null),
    ])
      .then(([selectedResult, referenceResult]) => {
        if (cancelled) return;
        const selectedParsed = parseCachedManiaBeatmap(selectedBeatmap.id, selectedResult.content);
        const referenceParsed = referenceResult && referenceBeatmapId
          ? parseCachedManiaBeatmap(referenceBeatmapId, referenceResult.content)
          : selectedParsed;
        const timedRateVariant = usesSetPreviewForReplayAudio && isLikelyTimedRateVariantSet(maniaBeatmaps);
        const previewPlan = getChartPreviewPlaybackPlan({
          selectedBeatmap: selectedParsed,
          referenceBeatmap: referenceParsed,
          usesSetPreviewForAudio: usesSetPreviewForReplayAudio,
          timedRateVariant,
          selectedDifficultyRate,
        });

        setPreviewBeatmap(previewPlan.beatmap);
        const scrubMs = replayChartScrub?.ms ?? null;
        if (scrubMs != null) {
          // Honour a user-picked scrub point: clamp it to the new chart and
          // force full-file audio so the audio can follow the chosen offset.
          let chartEnd = 0;
          for (const note of previewPlan.beatmap.notes) {
            if (note.endTime > chartEnd) chartEnd = note.endTime;
          }
          // Leave a little chart at the end so a scrub never lands on silence.
          const maxStart = Math.max(0, chartEnd - 2_000);
          const nextStartMs = Math.min(Math.max(0, scrubMs), maxStart);
          setReplayChartStartMs(nextStartMs);
          setReplayChartPlaybackMs(nextStartMs);
          setReplayChartTimeScale(1);
          setReplayAudioMode("selected-file");
        } else {
          setReplayChartStartMs(previewPlan.startTimeMs);
          setReplayChartPlaybackMs(previewPlan.startTimeMs);
          setReplayChartTimeScale(previewPlan.timeScale);
          setReplayAudioMode(resolveInitialChartPreviewAudioMode({
            plannedAudioMode: previewPlan.audioMode,
            hasSelectedAudioFile: Boolean(previewPlan.beatmap.audioFilename),
            hasSetPreviewAudio: Boolean(previewUrl),
            hasDifficultyPicker: maniaBeatmaps.length > 1,
            timedRateVariant,
          }));
        }
      })
      .catch(() => {
        if (cancelled) return;
        setPreviewBeatmap(null);
        setIsReplayPreviewReady(false);
        setReplayPreviewError("Couldn't load replay preview");
      })
      .finally(() => {
        if (!cancelled) setReplayPreviewLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [maniaBeatmaps, metadataBeatmapsetId, previewUrl, replayChartScrub, replayPreviewRequested, selectedBeatmap, selectedDifficultyRate, usesSetPreviewForReplayAudio]);

  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = volume;
    if (replayAudioRef.current) replayAudioRef.current.volume = volume;
  }, [previewUrl, replayAudioUrl, volume]);

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

  const pausePreviewAudio = useCallback((reset = false) => {
    previewPlaybackTokenRef.current += 1;
    const audio = audioRef.current;
    if (audio) {
      const pausedAt = audio.currentTime;
      audio.pause();
      audio.playbackRate = 1;
      setAudioPreservesPitch(audio, true);
      if (reset) {
        try {
          audio.currentTime = 0;
        } catch {
          // Ignore seek failures while the source is changing.
        }
        setCurrentTime(0);
      } else {
        setCurrentTime(pausedAt);
      }
    }
    setIsPreviewPlaying(false);
  }, []);

  const stopPreview = useCallback(() => {
    pausePreviewAudio(true);
  }, [pausePreviewAudio]);

  const clearReplayPreviewEndTimer = useCallback(() => {
    if (replayPreviewEndTimerRef.current) {
      clearTimeout(replayPreviewEndTimerRef.current);
      replayPreviewEndTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    isRandomCardMountedRef.current = true;
    return () => {
      isRandomCardMountedRef.current = false;
      previewPlaybackTokenRef.current += 1;
      replayPlaybackTokenRef.current += 1;
      replayAudioStartPendingRef.current = false;
      replayAudioReadyRef.current = false;
      replayAudioClockSampleRef.current = null;
      replayAudioClockAnchorRef.current = null;
      requestedAudioModeRef.current = null;
      clearReplayPreviewEndTimer();
      releasePreviewAnalyser(audioRef.current);
      resetAudioElement(audioRef.current, true);
      resetAudioElement(replayAudioRef.current, true);
    };
  }, [clearReplayPreviewEndTimer]);

  const finishReplayPreview = useCallback(() => {
    if (replayPreviewEndTimerRef.current) return;
    const audio = replayAudioRef.current;
    replayPlaybackTokenRef.current += 1;
    replayAudioStartPendingRef.current = false;
    replayAudioReadyRef.current = false;
    replayAudioClockSampleRef.current = null;
    replayAudioClockAnchorRef.current = null;
    replayAudioStartSecondsRef.current = 0;
    requestedAudioModeRef.current = null;
    setIsPreviewPlaying(false);
    setReplayAudioLoading(false);
    setIsReplayPreviewEnding(true);
    if (audio) {
      resetAudioElement(audio);
    }
    replayPreviewEndTimerRef.current = setTimeout(() => {
      replayPreviewEndTimerRef.current = null;
      setReplayPreviewRequested(false);
      setIsReplayPreviewPlaying(false);
      setIsReplayPreviewEnding(false);
      setIsReplayPreviewReady(false);
      setReplayAudioLoading(false);
    }, 220);
  }, []);

  const resetReplayPreview = useCallback(() => {
    clearReplayPreviewEndTimer();
    replayPlaybackTokenRef.current += 1;
    replayAudioStartPendingRef.current = false;
    replayAudioReadyRef.current = false;
    replayAudioClockSampleRef.current = null;
    replayAudioClockAnchorRef.current = null;
    replayAudioStartSecondsRef.current = 0;
    setReplayPreviewRequested(false);
    setIsReplayPreviewPlaying(false);
    setIsReplayPreviewEnding(false);
    setIsReplayPreviewReady(false);
    setReplayAudioLoading(false);
    setReplayAudioSizeBytes(null);
    setPreviewBeatmap(null);
    setReplayChartStartMs(0);
    setReplayChartPlaybackMs(0);
    setReplayChartTimeScale(1);
    setReplayAudioMode("set-preview");
    setReplayChartScrub(null);
    setReplayPreviewError(null);
    resetAudioElement(replayAudioRef.current);
    if (requestedAudioModeRef.current === "replay") {
      requestedAudioModeRef.current = null;
    }
  }, [clearReplayPreviewEndTimer]);

  const togglePreview = useCallback(async () => {
    if (!previewUrl) return;
    const audio = audioRef.current;
    if (!audio) return;

    if (isPreviewPlaying) {
      previewPlaybackTokenRef.current += 1;
      setCurrentTime(audio.currentTime);
      audio.pause();
      return;
    }

    resetReplayPreview();
    const token = previewPlaybackTokenRef.current + 1;
    previewPlaybackTokenRef.current = token;
    requestedAudioModeRef.current = "audio";
    setPreviewError(null);
    try {
      const resumeTime = currentTime > 0 && (!duration || currentTime < Math.min(duration, RANDOM_REPLAY_PREVIEW_MS / 1000))
        ? currentTime
        : 0;
      try {
        audio.currentTime = resumeTime;
      } catch {
        // Let the browser start from its current buffered position if seeking is not ready.
      }
      setCurrentTime(resumeTime);
      audio.volume = volume;
      audio.playbackRate = 1;
      setAudioPreservesPitch(audio, true);
      await audio.play();
      if (
        !isRandomCardMountedRef.current ||
        previewPlaybackTokenRef.current !== token ||
        requestedAudioModeRef.current !== "audio" ||
        audioRef.current !== audio
      ) {
        resetAudioElement(audio);
      }
    } catch {
      if (
        isRandomCardMountedRef.current &&
        previewPlaybackTokenRef.current === token &&
        requestedAudioModeRef.current === "audio" &&
        audioRef.current === audio
      ) {
        setPreviewError("Couldn't play preview");
        setIsPreviewPlaying(false);
      }
    }
  }, [currentTime, duration, isPreviewPlaying, previewUrl, resetReplayPreview, volume]);

  // After the proxy fallback remounts the audio element on the direct URL,
  // resume the play the user asked for.
  useEffect(() => {
    if (!previewProxyFailed || !retryPreviewAfterProxyFailRef.current) return;
    retryPreviewAfterProxyFailRef.current = false;
    void togglePreview();
  }, [previewProxyFailed, togglePreview]);

  const startReplayPreviewAudio = useCallback(async (token: number) => {
    const audio = replayAudioRef.current;
    const isCurrentRequest = () =>
      isRandomCardMountedRef.current &&
      replayPlaybackTokenRef.current === token &&
      requestedAudioModeRef.current === "replay" &&
      replayAudioRef.current === audio;
    if (!replayAudioUrl) {
      if (replayPlaybackTokenRef.current === token) {
        replayAudioStartPendingRef.current = false;
        replayAudioReadyRef.current = false;
        replayAudioClockSampleRef.current = null;
        replayAudioClockAnchorRef.current = null;
        setReplayAudioLoading(false);
        setReplayPreviewError("Couldn't find chart preview audio");
      }
      return;
    }
    if (!audio) return;
    requestedAudioModeRef.current = "replay";
    replayAudioStartPendingRef.current = false;
    replayAudioReadyRef.current = false;
    resetReplayAudioClockSample(replayAudioClockSampleRef, replayPreviewStartSeconds);
    replayAudioClockAnchorRef.current = null;
    pausePreviewAudio(false);
    setPreviewError(null);
    replayAudioStartSecondsRef.current = replayPreviewStartSeconds;
    audio.pause();
    const isSelectedFileAudio = replayAudioMode === "selected-file";
    audio.volume = volume;
    audio.playbackRate = replayAudioPlaybackRate;
    setAudioPreservesPitch(audio, replayAudioMode !== "set-preview");
    try {
      setReplayAudioLoading(isSelectedFileAudio);
      if (isSelectedFileAudio && replayAudioSizeBytes == null) {
        try {
          const sizeResponse = await fetch(replayAudioUrl, { method: "HEAD" });
          if (!isCurrentRequest()) {
            resetAudioElement(audio);
            return;
          }
          if (sizeResponse.ok) {
            const sizeRaw = sizeResponse.headers.get("x-audio-size-bytes") ?? sizeResponse.headers.get("content-length");
            const size = sizeRaw ? Number(sizeRaw) : NaN;
            if (Number.isFinite(size) && size > 0) setReplayAudioSizeBytes(size);
          }
        } catch {
          if (!isCurrentRequest()) {
            resetAudioElement(audio);
            return;
          }
        }
      }
      if (!isCurrentRequest()) {
        resetAudioElement(audio);
        return;
      }
      if (isSelectedFileAudio) {
        audio.preload = "auto";
        try {
          audio.load();
        } catch {
          // Some browsers may reject load() while React is still swapping sources.
        }
      }
      try {
        audio.currentTime = replayPreviewStartSeconds;
      } catch {
        // The metadata may not be ready yet on mobile; playback will still be clipped.
      }
      await seekAudioElement(audio, replayPreviewStartSeconds, isSelectedFileAudio
        ? {
          metadataTimeoutMs: SELECTED_AUDIO_METADATA_TIMEOUT_MS,
          requireMetadata: true,
          seekSettleTimeoutMs: SELECTED_AUDIO_SEEK_SETTLE_TIMEOUT_MS,
        }
        : undefined);
      if (!isCurrentRequest()) {
        resetAudioElement(audio);
        return;
      }
      if (replayPreviewStartSeconds > 0.25 && Math.abs(audio.currentTime - replayPreviewStartSeconds) > 1) {
        throw new Error("Chart preview audio seek failed");
      }
      await audio.play();
      if (!isCurrentRequest()) {
        resetAudioElement(audio);
        return;
      }
      resetReplayAudioClockSample(replayAudioClockSampleRef, audio.currentTime);
      replayAudioClockAnchorRef.current = {
        mediaSeconds: audio.currentTime,
        startedAtMs: performance.now(),
        playbackRate: getReplayAudioPlaybackRate(audio, replayAudioPlaybackRate),
      };
      replayAudioReadyRef.current = true;
      setIsReplayPreviewPlaying(true);
      setReplayAudioLoading(false);
    } catch {
      if (isCurrentRequest()) {
        replayAudioReadyRef.current = false;
        replayAudioClockSampleRef.current = null;
        replayAudioClockAnchorRef.current = null;
        setReplayAudioLoading(false);
        setPreviewError("Couldn't play preview audio");
        setIsReplayPreviewPlaying(false);
      }
    }
  }, [pausePreviewAudio, replayAudioMode, replayAudioPlaybackRate, replayAudioSizeBytes, replayAudioUrl, replayPreviewStartSeconds, volume]);

  const getReplayChartPlaybackMs = useCallback(() => {
    const baseMs = Math.max(0, replayChartStartMs);
    const audio = replayAudioRef.current;
    if (!audio || requestedAudioModeRef.current !== "replay" || !replayAudioReadyRef.current) {
      return Math.min(baseMs, Math.max(0, replayChartLengthMs));
    }

    const elapsedMediaMs = Math.max(0, (audio.currentTime - replayAudioStartSecondsRef.current) * 1000);
    const displayMs = elapsedMediaMs / Math.max(0.1, replayClockRateDivisor);
    const chartMs = baseMs + (displayMs * Math.max(0.1, replayChartTimeScale));
    return Math.min(Math.max(0, chartMs), Math.max(0, replayChartLengthMs));
  }, [replayChartLengthMs, replayChartStartMs, replayChartTimeScale, replayClockRateDivisor]);

  useEffect(() => {
    if (!replayPreviewRequested || isReplayPreviewEnding) return;

    let frameId: number | null = null;
    const update = () => {
      const nextMs = getReplayChartPlaybackMs();
      setReplayChartPlaybackMs((currentMs) => (
        Math.abs(currentMs - nextMs) >= 16 ? nextMs : currentMs
      ));

      if (isReplayPreviewPlaying) {
        frameId = window.requestAnimationFrame(update);
      }
    };

    update();
    return () => {
      if (frameId != null) window.cancelAnimationFrame(frameId);
    };
  }, [getReplayChartPlaybackMs, isReplayPreviewEnding, isReplayPreviewPlaying, replayPreviewRequested]);

  const getReplayPreviewClock = useCallback(() => {
    const audio = replayAudioRef.current;
    if (!audio || requestedAudioModeRef.current !== "replay") {
      return { time: 0, stalled: true };
    }
    if (!replayAudioReadyRef.current || audio.paused || audio.seeking) {
      return { time: 0, stalled: true };
    }
    const rate = Math.max(0.1, replayClockRateDivisor);
    const now = performance.now();
    const rawMediaSeconds = audio.currentTime;
    const anchor = replayAudioClockAnchorRef.current;
    let mediaSeconds = rawMediaSeconds;
    if (anchor) {
      const predictedSeconds = anchor.mediaSeconds + ((now - anchor.startedAtMs) / 1000) * anchor.playbackRate;
      if (rawMediaSeconds > predictedSeconds + 0.12) {
        replayAudioClockAnchorRef.current = {
          mediaSeconds: rawMediaSeconds,
          startedAtMs: now,
          playbackRate: getReplayAudioPlaybackRate(audio, replayAudioPlaybackRate),
        };
        mediaSeconds = rawMediaSeconds;
      } else {
        mediaSeconds = Math.max(rawMediaSeconds, predictedSeconds);
      }
    }
    const elapsedSeconds = Math.max(0, mediaSeconds - replayAudioStartSecondsRef.current);
    const lowReadyState = audio.readyState < HTMLMediaElement.HAVE_CURRENT_DATA;
    const audioClockIsMoving = anchor != null || hasRecentReplayAudioClockProgress(replayAudioClockSampleRef, mediaSeconds);
    return {
      time: Math.min(replayPreviewWindowMs, (elapsedSeconds * 1000) / rate),
      stalled: lowReadyState && !audioClockIsMoving,
    };
  }, [replayAudioPlaybackRate, replayClockRateDivisor, replayPreviewWindowMs]);

  const markReplayPreviewReady = useCallback(() => {
    setIsReplayPreviewReady(true);
  }, []);

  // Jump the chart preview to an arbitrary point in the map. Pins the scrub
  // offset and restarts the playback pipeline: the plan effect re-resolves the
  // chart, the renderer re-keys, and the pending-audio effect starts playback.
  const seekChartPreview = useCallback((targetMs: number) => {
    clearReplayPreviewEndTimer();
    const token = replayPlaybackTokenRef.current + 1;
    replayPlaybackTokenRef.current = token;
    requestedAudioModeRef.current = "replay";
    replayAudioReadyRef.current = false;
    replayAudioStartPendingRef.current = true;
    replayAudioClockSampleRef.current = null;
    replayAudioClockAnchorRef.current = null;
    resetAudioElement(replayAudioRef.current);
    pausePreviewAudio(false);
    setIsReplayPreviewPlaying(false);
    setIsReplayPreviewReady(false);
    setIsReplayPreviewEnding(false);
    setReplayPreviewError(null);
    setReplayPreviewRequested(true);
    const nextMs = Math.max(0, Math.round(targetMs));
    setReplayChartPlaybackMs(nextMs);
    setReplayChartScrub((prev) => ({
      ms: nextMs,
      nonce: (prev?.nonce ?? 0) + 1,
    }));
  }, [clearReplayPreviewEndTimer, pausePreviewAudio]);

  // Pause or resume the running chart preview (clicking the playfield toggles
  // it). The audio is the master clock, so resuming re-anchors the dead-reckon
  // clock to the audio's current position to avoid a time jump.
  const toggleChartPreviewPlayback = useCallback(() => {
    const audio = replayAudioRef.current;
    if (!audio || requestedAudioModeRef.current !== "replay" || !replayAudioReadyRef.current) return;
    if (isReplayPreviewPlaying) {
      setReplayChartPlaybackMs(getReplayChartPlaybackMs());
      audio.pause();
      replayAudioClockAnchorRef.current = null;
      setIsReplayPreviewPlaying(false);
      return;
    }
    resetReplayAudioClockSample(replayAudioClockSampleRef, audio.currentTime);
    replayAudioClockAnchorRef.current = {
      mediaSeconds: audio.currentTime,
      startedAtMs: performance.now(),
      playbackRate: getReplayAudioPlaybackRate(audio, replayAudioPlaybackRate),
    };
    audio.volume = volume;
    void audio.play()
      .then(() => {
        if (replayAudioRef.current !== audio || requestedAudioModeRef.current !== "replay") return;
        setIsReplayPreviewPlaying(true);
      })
      .catch(() => {
        replayAudioClockAnchorRef.current = null;
      });
  }, [getReplayChartPlaybackMs, isReplayPreviewPlaying, replayAudioPlaybackRate, volume]);

  const startReplayPreview = useCallback(() => {
    const audio = replayAudioRef.current;
    clearReplayPreviewEndTimer();
    const token = replayPlaybackTokenRef.current + 1;
    replayPlaybackTokenRef.current = token;
    requestedAudioModeRef.current = "replay";
    replayAudioReadyRef.current = false;
    resetReplayAudioClockSample(replayAudioClockSampleRef, replayPreviewStartSeconds);
    replayAudioClockAnchorRef.current = null;
    setIsReplayPreviewPlaying(false);
    setIsReplayPreviewEnding(false);
    pausePreviewAudio(false);
    if (audio) {
      audio.pause();
      try {
        audio.currentTime = replayPreviewStartSeconds;
      } catch {
        // The audio element may still be resolving its source on mobile.
      }
      audio.volume = volume;
      audio.playbackRate = replayAudioPlaybackRate;
      setAudioPreservesPitch(audio, replayAudioMode !== "set-preview");
    }
    replayAudioStartSecondsRef.current = replayPreviewStartSeconds;
    setReplayChartPlaybackMs(replayChartStartMs);
    setReplayPreviewRequested(true);
    replayAudioStartPendingRef.current = true;
    if (previewBeatmap && isReplayPreviewReady) {
      void startReplayPreviewAudio(token);
    }
  }, [clearReplayPreviewEndTimer, isReplayPreviewReady, pausePreviewAudio, previewBeatmap, replayAudioMode, replayAudioPlaybackRate, replayChartStartMs, replayPreviewStartSeconds, startReplayPreviewAudio, volume]);

  useEffect(() => {
    if (replayPreviewRequested && previewBeatmap && isReplayPreviewReady && !replayPreviewLoading && replayAudioStartPendingRef.current) {
      void startReplayPreviewAudio(replayPlaybackTokenRef.current);
    }
  }, [isReplayPreviewReady, previewBeatmap, replayPreviewLoading, replayPreviewRequested, startReplayPreviewAudio]);

  const applyVolume = useCallback((v: number) => {
    const clamped = Math.min(1, Math.max(0, v));
    setVolume(clamped);
    if (audioRef.current) audioRef.current.volume = clamped;
    if (replayAudioRef.current) replayAudioRef.current.volume = clamped;
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

  const displayDuration = duration > 0 ? Math.min(duration, RANDOM_REPLAY_PREVIEW_MS / 1000) : 0;
  const getPreviewAudio = useCallback(() => audioRef.current, []);
  // Paused == the preview is live and ready but the user stopped it; that is
  // distinct from "preparing" (still spinning up), which keeps the spinner.
  // replayAudioReadyRef is true only once audio playback has been established,
  // so it cleanly excludes the brief ready-but-not-yet-playing startup gap.
  const isReplayPreviewPaused = replayPreviewRequested
    && isReplayPreviewReady
    && replayAudioReadyRef.current
    && !isReplayPreviewPlaying
    && !isReplayPreviewEnding
    && !replayAudioLoading
    && !previewError
    && !replayPreviewError;
  const isReplayPreviewPreparing = replayPreviewRequested
    && !isReplayPreviewEnding
    && !isReplayPreviewPlaying
    && !isReplayPreviewPaused
    && !replayAudioLoading
    && !previewError
    && !replayPreviewError;
  // The playfield itself is clickable to pause/resume once a preview is live.
  const canToggleChartPreview = replayPreviewRequested
    && !isReplayPreviewEnding
    && !replayAudioLoading
    && (isReplayPreviewPlaying || isReplayPreviewReady);

  return (
    <div className="relative w-[640px] max-w-full">
      <div className="rounded-2xl bg-osu-b4 border border-osu-b3/20 hover:border-osu-pink/40 transition-colors">
        <a href={url} target="_blank" rel="noreferrer" className="block relative rounded-t-2xl overflow-hidden">
        <div className="relative w-full h-[220px] bg-osu-b6 overflow-hidden">
          {!coverReady && coverUrl !== "" && (
            <Skeleton className="absolute inset-0 rounded-none" />
          )}
          {coverUrl && (
            <div
              className={`absolute inset-0 bg-cover bg-center transition-opacity duration-500 ${coverReady ? "opacity-100" : "opacity-0"}`}
              style={coverReady ? { backgroundImage: `url("${coverUrl.replace(/"/g, '\\"')}")` } : undefined}
              aria-hidden="true"
            />
          )}
        </div>
        <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/20 to-transparent" />
        <BeatmapStatusBadge status={bm.status} className="absolute top-3 left-3" />
        <div className="absolute top-3 right-3 flex max-w-[calc(100%-5.5rem)] flex-wrap items-center justify-end gap-1">
          {keys.map((k) => (
            <span key={k} className="inline-flex items-center rounded-full bg-black/70 px-2 py-0.5 text-[10px] font-bold leading-none tabular-nums text-white">
              {k}K
            </span>
          ))}
          {starLabel && (
            <StarRatingBadge stars={typeof bm.starMax === "number" ? bm.starMax : 0} label={starLabel} />
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
            {mapMetadata.length > 0 && (
              <div className="text-[10px] text-osu-f1/80 truncate">{mapMetadata.join(" / ")}</div>
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
            <a
              href={`osu://dl/${bm.id}`}
              className="hidden sm:flex items-center gap-1.5 text-osu-pink/80 hover:text-osu-pink hover:scale-105 transition-all cursor-pointer focus:outline-none focus-visible:outline-none"
              title="Open in osu!"
            >
              <span className="text-[11px] font-semibold">Open in</span>
              <OsuLogo className="h-[26px] w-[26px]" />
            </a>
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

        {maniaBeatmaps.length > 1 ? (
          <div className="flex items-center gap-2">
            <span className="shrink-0 text-[9px] font-bold uppercase tracking-wide text-osu-f1/80">
              Diff
            </span>
            <DifficultyPicker
              beatmaps={maniaBeatmaps}
              selectedId={selectedBeatmap?.id ?? null}
              onChange={(id) => {
                resetReplayPreview();
                setSelectedBeatmapId(id);
              }}
            />
            <span className="shrink-0 rounded-md bg-osu-b3/50 px-2 py-1 text-[10px] font-semibold text-osu-f1">
              {maniaBeatmaps.length} diffs
            </span>
          </div>
        ) : null}

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
                  if (!audio || !displayDuration || requestedAudioModeRef.current !== "audio") return;
                  const rect = e.currentTarget.getBoundingClientRect();
                  const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
                  try {
                    audio.currentTime = ratio * displayDuration;
                  } catch {
                    return;
                  }
                  setCurrentTime(audio.currentTime);
                }}
                className="flex-1 h-1 bg-osu-b3/60 rounded-full cursor-pointer relative group"
              >
                <BeatWaveFill getAudio={getPreviewAudio} bpm={bm.bpm} maxSeconds={displayDuration} analysable={usePreviewProxy} />
              </div>

              <span className="text-[9px] text-osu-f1 tabular-nums shrink-0">
                {formatDuration(Math.floor(currentTime))}/{displayDuration > 0 ? formatDuration(Math.floor(displayDuration)) : "--:--"}
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
              // Remount on source strategy change: an element that ever fed
              // the analyser graph plays silence for a tainted (direct
              // b.ppy.sh) src, so the fallback needs a fresh element.
              key={effectivePreviewUrl}
              ref={audioRef}
              src={effectivePreviewUrl}
              crossOrigin={usePreviewProxy ? "anonymous" : undefined}
              preload="metadata"
              onLoadedMetadata={(e) => {
                e.currentTarget.volume = volume;
                setDuration(e.currentTarget.duration || 0);
              }}
              onTimeUpdate={(e) => {
                const audio = e.currentTarget;
                if (requestedAudioModeRef.current !== "audio") return;
                const maxSeconds = RANDOM_REPLAY_PREVIEW_MS / 1000;
                setCurrentTime(Math.min(audio.currentTime, maxSeconds));
                if (audio.currentTime >= maxSeconds) {
                  stopPreview();
                }
              }}
              onEnded={() => {
                if (requestedAudioModeRef.current === "audio") {
                  stopPreview();
                }
              }}
              onPause={() => setIsPreviewPlaying(false)}
              onPlay={() => setIsPreviewPlaying(requestedAudioModeRef.current === "audio")}
              onError={() => {
                if (usePreviewProxy) {
                  // Proxy unavailable (older backend, transient error): fall
                  // back to the direct b.ppy.sh clip and resume if a play was
                  // in flight. The key remount discards this element.
                  releasePreviewAnalyser(audioRef.current);
                  retryPreviewAfterProxyFailRef.current = requestedAudioModeRef.current === "audio";
                  setPreviewProxyFailed(true);
                  setIsPreviewPlaying(false);
                  return;
                }
                setPreviewError("Couldn't load preview");
                setIsPreviewPlaying(false);
              }}
            />
            {replayAudioUrl ? (
              <audio
                ref={replayAudioRef}
                src={replayAudioUrl}
                preload={replayAudioMode === "set-preview" ? "metadata" : "none"}
                onCanPlay={(e) => {
                  e.currentTarget.volume = volume;
                  setReplayAudioLoading(false);
                }}
                onPlaying={(e) => {
                  e.currentTarget.volume = volume;
                  setReplayAudioLoading(false);
                }}
                onTimeUpdate={(e) => {
                  const audio = e.currentTarget;
                  const maxSeconds = replayAudioStartSecondsRef.current + ((replayPreviewWindowMs / 1000) * replayAudioPlaybackRate);
                  if (audio.currentTime >= maxSeconds) {
                    finishReplayPreview();
                  }
                }}
                onEnded={finishReplayPreview}
                onError={() => {
                  setReplayAudioLoading(false);
                  setPreviewError("Couldn't load chart preview audio");
                  setIsReplayPreviewPlaying(false);
                  replayAudioStartPendingRef.current = false;
                  replayAudioReadyRef.current = false;
                  replayAudioClockSampleRef.current = null;
                  replayAudioClockAnchorRef.current = null;
                }}
              />
            ) : null}
          </div>
        ) : null}
        {previewError ? (
          <div className="text-[10px] text-rose-300">{previewError}</div>
        ) : null}
        </div>
      </div>

      <div
        className="relative mt-4 min-h-[420px] overflow-visible md:absolute md:left-[calc(100%_+_var(--replay-preview-gap))] md:top-[calc(var(--replay-preview-top-bleed)*-1)] md:mt-0 md:h-[calc(100%+var(--replay-preview-top-bleed))] md:w-[var(--replay-preview-width)] md:min-h-[calc(100%+var(--replay-preview-top-bleed))]"
        style={{
          "--replay-preview-gap": `${replayPreviewGap}px`,
          "--replay-preview-top-bleed": `${replayPreviewTopBleed}px`,
          "--replay-preview-width": `${replayPreviewWidth}px`,
        } as CSSProperties}
      >
        <div
          onClick={canToggleChartPreview ? toggleChartPreviewPlayback : undefined}
          className={`absolute inset-x-0 top-0 transition-opacity duration-200 ${
            canScrubChartPreview ? "bottom-7" : "bottom-0"
          } ${
            previewBeatmap && !isReplayPreviewEnding ? "opacity-100" : "opacity-0"
          } ${canToggleChartPreview ? "cursor-pointer" : ""}`}
        >
          {previewBeatmap ? (
            <RandomReplayPreview
              key={selectedBeatmap?.id ?? "preview"}
              beatmap={previewBeatmap}
              startTimeMs={replayChartStartMs}
              timeScale={replayChartTimeScale}
              windowMs={replayPreviewWindowMs}
              isPlaying={isReplayPreviewPlaying}
              resetWhenIdle={!replayPreviewRequested || isReplayPreviewEnding}
              getClock={getReplayPreviewClock}
              onReady={markReplayPreviewReady}
              onEnded={finishReplayPreview}
            />
          ) : null}
        </div>
        {replayPreviewRequested && !isReplayPreviewEnding && canScrubChartPreview ? (
          <div className="absolute inset-x-2 bottom-1.5 z-30">
            <ChartPreviewTimeline
              positionMs={replayChartPlaybackMs}
              lengthMs={replayChartLengthMs}
              onSeek={seekChartPreview}
            />
          </div>
        ) : null}
        {replayAudioLoading ? (
          <div className="absolute inset-0 z-30 grid place-items-center bg-osu-b5/45 backdrop-blur-[1px]">
            <div className="grid h-8 w-8 place-items-center rounded-md border border-osu-b3/50 bg-osu-b5/85 shadow-lg">
              <div className="h-4 w-4 rounded-full border-2 border-osu-pink/40 border-t-osu-pink animate-spin" />
            </div>
          </div>
        ) : null}
        {isReplayPreviewPreparing ? (
          <div className="pointer-events-none absolute inset-0 z-30 grid place-items-center">
            <div className="grid h-7 w-7 place-items-center rounded-md border border-osu-b3/40 bg-osu-b5/65 shadow-lg shadow-black/20 backdrop-blur-[1px]">
              <div className="h-3.5 w-3.5 rounded-full border-2 border-osu-f1/25 border-t-osu-pink/90 animate-spin" />
            </div>
          </div>
        ) : null}
        {isReplayPreviewPaused ? (
          <div className="pointer-events-none absolute inset-0 z-30 grid place-items-center">
            <div className="grid h-10 w-10 place-items-center rounded-full border border-osu-f1/30 bg-osu-b5/70 shadow-lg shadow-black/20 backdrop-blur-[1px]">
              <svg viewBox="0 0 24 24" fill="currentColor" className="ml-0.5 h-4 w-4 text-osu-l2" aria-hidden>
                <path d="M8 5v14l11-7z" />
              </svg>
            </div>
          </div>
        ) : null}
        {selectedBeatmap ? (
          <button
            type="button"
            onClick={startReplayPreview}
            className={`absolute left-1/2 top-1/2 z-20 flex -translate-x-1/2 -translate-y-1/2 items-center gap-2 rounded-md border border-osu-f1/35 bg-osu-b5/70 px-3 py-1.5 text-[11px] font-semibold text-osu-l2 backdrop-blur-sm transition-all duration-200 hover:border-osu-l2/70 hover:bg-osu-b4/80 hover:text-white cursor-pointer md:left-[150px] ${
              replayPreviewRequested && !isReplayPreviewEnding ? "pointer-events-none opacity-0 scale-95" : "opacity-100 scale-100"
            }`}
          >
            <svg
              viewBox="0 0 24 24"
              fill="currentColor"
              className="h-3 w-3"
              aria-hidden
            >
              <path d="M8 5v14l11-7z" />
            </svg>
            <span>chart preview</span>
          </button>
        ) : null}
        {replayPreviewError ? (
          <div className="absolute inset-x-3 top-3 rounded-md bg-black/60 px-2 py-1 text-[10px] text-rose-300">
            {replayPreviewError}
          </div>
        ) : null}
      </div>
    </div>
  );
}
