import { createFileRoute, stripSearchParams, useNavigate } from "@tanstack/react-router";
import { useState, useEffect, useLayoutEffect, useMemo, useRef, useCallback, useDeferredValue } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import {
  getRankings,
  getCountryMapsFarmed,
  getCountryMapsFavourites,
  getBeatmapFile,
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
  ReplayFrame,
} from "../lib/types";
import type { ManiaBeatmap, ManiaNote, ManiaScrollVelocity } from "../lib/beatmap-parser";
import { useAppStore, useHiddenUserIds, useSelectedCountry } from "../store";
import { pageSeo, mapsOgImagePath } from "../lib/seo";
import { parseCountrySearchParam, withSearchParams } from "../lib/country-search";
import { getBeatmapAudioUrl } from "../lib/audio-url";
import {
  RANDOM_REPLAY_PREVIEW_MS,
  buildAutoplayFrames,
  getChartPreviewPlaybackPlan,
  getPreviewInitialCombo,
  getPreviewNotes,
  getPreviewScrollVelocities,
} from "../lib/chart-preview";
import { REPLAY_SCROLL_SPEED_CHANGE_EVENT, readReplayScrollSpeed } from "../lib/replay-scroll-speed";
import { REPLAY_SKIN_SETTINGS_CHANGE_EVENT, readReplaySkinSettings } from "../lib/replay-skin";
import type { ReplaySkinSettings } from "../lib/replay-skin";
import { useAuth } from "../lib/auth-context";
import {
  fetchLiveMapsBeatmapsets,
  fetchLiveMapsPageSnapshot,
  fetchLiveMapsPlayersSnapshot,
  fetchLiveMapsSnapshot,
  isLiveBackendConfigured,
  openLiveEventSource,
  runLiveBackendAdminAction,
} from "../lib/live-backend";
import { LIVE_MAPS_PLAYERS_PAGE_SIZE } from "../lib/live-backend";
import type { LiveMapsBrowseTab, LiveMapsDetailsPlayer, LiveMapsPageValue, LiveMapsPlayersKind } from "../lib/live-backend";
import { CountryWarming } from "../components/CountryWarming";
import { useCountryWarming } from "../lib/use-country-warming";
import { parseCachedManiaBeatmap } from "../lib/parsed-beatmap-cache";
import {
  cycleTriStateCsv,
  getTriStateMode,
  parseTriStateCsv,
  reverseCycleTriStateCsv,
  triStateActive,
} from "../lib/maps-random-filter";
import type { TriStateMode } from "../lib/maps-random-filter";

// ── Types ──────────────────────────────────────────────────────────────────

type Tab = "farmed" | "popular" | "favourites" | "random";
type KeyFilter = "all" | "4k" | "7k" | "other";
type BeatmapSort = "plays" | "players" | "stars" | "length";
type FarmedSort = "players" | "avg-pp" | "max-pp" | "stars" | "recent";
type SortDirection = "desc" | "asc";
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
  country: string | undefined;
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
  country: undefined,
};

type RandomPickSettings = Pick<MapsSearch, "rWeight" | "rAvoidRepeats">;
type LiveMapsPageState = LiveMapsPageValue & { requestKey: string };
const liveMapsPageSessionCache = new Map<string, LiveMapsPageState>();
const liveMapsPageTotalSessionCache = new Map<string, number>();

function readRandomPickSettings(): Partial<RandomPickSettings> {
  if (typeof window === "undefined") return {};

  try {
    const raw = localStorage.getItem(RANDOM_PICK_SETTINGS_STORAGE_KEY);
    if (!raw) return {};

    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};

    const settings: Partial<RandomPickSettings> = {};
    const { rWeight, rAvoidRepeats } = parsed as Record<string, unknown>;
    if (rWeight === "players" || rWeight === "favourites") settings.rWeight = rWeight;
    if (typeof rAvoidRepeats === "boolean") settings.rAvoidRepeats = rAvoidRepeats;
    return settings;
  } catch (error) {
    console.warn("[maps] failed to read random pick settings", error);
    return {};
  }
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

// ── Helpers ────────────────────────────────────────────────────────────────

function parseKeyCount(version: string): number | null {
  const match = version.match(/\b(\d)K\b/i);
  return match ? parseInt(match[1]) : null;
}

function parseDifficultyRate(version: string): number {
  const matches = [...version.matchAll(/(^|[^\da-z])(?:x\s*)?([01](?:\.\d{1,3})|2(?:\.0{1,3})?)(?:\s*[x×])?(?=$|[^\d])/gi)];
  for (let i = matches.length - 1; i >= 0; i--) {
    const value = Number.parseFloat(matches[i][2]);
    if (Number.isFinite(value) && value >= 0.5 && value <= 2) return value;
  }
  return 1;
}

function parseBracketBpm(version: string): number | null {
  const matches = [...version.matchAll(/\[(\d{2,3})\]/g)];
  for (let i = matches.length - 1; i >= 0; i--) {
    const value = Number.parseInt(matches[i][1], 10);
    if (Number.isFinite(value) && value >= 60 && value <= 400) return value;
  }
  return null;
}

function normalizeRateVariantVersion(version: string): string {
  return stripRateVariantDecorations(version)
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function stripRateVariantDecorations(version: string): string {
  return version
    .toLowerCase()
    .replace(/\[[^\]]*?\b\d+k\b[^\]]*?\]/gi, " ")
    .replace(/\b\d+k\b/gi, " ")
    .replace(/(^|[^\da-z])x?\s*(?:[01](?:\.\d{1,3})|2(?:\.0{1,3})?)\s*[x×]?(?=$|[^\d])/gi, "$1 ")
    .replace(/\b\d{2,3}\s*bpm\b/gi, " ")
    .replace(/\brate\b/gi, " ")
    .trim();
}

function normalizeBracketBpmVariantVersion(version: string): string {
  return version
    .toLowerCase()
    .replace(/\[[^\]]*?\b\d+k\b[^\]]*?\]/gi, " ")
    .replace(/\b\d+k\b/gi, " ")
    .replace(/\[\d{2,3}\]/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function normalizeNumericVariantVersion(version: string): string {
  return version
    .toLowerCase()
    .replace(/\[[^\]]*?\b\d+k\b[^\]]*?\]/gi, " ")
    .replace(/\b\d+k\b/gi, " ")
    .replace(/\b\d[\d,.]*\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const ORDINARY_DIFFICULTY_WORDS = new Set([
  "4k",
  "5k",
  "6k",
  "7k",
  "8k",
  "9k",
  "10k",
  "11k",
  "12k",
  "13k",
  "14k",
  "15k",
  "16k",
  "beginner",
  "easy",
  "normal",
  "hard",
  "insane",
  "desperate",
  "expert",
  "extra",
  "extreme",
  "advanced",
  "hyper",
  "another",
  "oni",
  "ura",
  "master",
  "ultimate",
  "challenge",
  "light",
  "standard",
  "heavy",
  "novice",
  "apprentice",
  "intermediate",
  "advanced",
  "diff",
  "difficulty",
  "lv",
  "lvl",
  "level",
  "ez",
  "nm",
  "hd",
  "shd",
  "ex",
  "mx",
  "sc",
]);

function normalizeOrdinaryDifficultyVersion(version: string): string[] {
  return version
    .toLowerCase()
    .replace(/\[[^\]]*?\b\d+k\b[^\]]*?\]/gi, " ")
    .replace(/\b[\w.-]+(?:'s|’s)\b/gi, " ")
    .replace(/(^|[^\da-z])x?\s*(?:[01](?:\.\d{1,3})|2(?:\.0{1,3})?)\s*[x×]?(?=$|[^\d])/gi, "$1 ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function isOrdinaryDifficultyName(version: string): boolean {
  const words = normalizeOrdinaryDifficultyVersion(version);
  return words.length > 0 && words.every((word) => /^\d+$/.test(word) || ORDINARY_DIFFICULTY_WORDS.has(word));
}

function hasOrdinaryDifficultySuffix(version: string): boolean {
  const parts = version
    .split(/[|:/\\]+/g)
    .map((part) => part.trim())
    .filter(Boolean);
  const suffix = parts.at(-1);
  return !!suffix && parts.length > 1 && isOrdinaryDifficultyName(suffix);
}

function looksLikeSongPackVersion(version: string): boolean {
  const cleaned = version
    .replace(/\[[^\]]*?\b\d+k\b[^\]]*?\]/gi, " ")
    .replace(/\b\d+k\b/gi, " ")
    .trim();
  return /\s[-–—]\s/.test(cleaned);
}

function isLikelyRateVariantSet(beatmaps: NonNullable<MapsFavouriteBeatmapset["maniaBeatmaps"]>): boolean {
  if (beatmaps.length <= 1) return false;
  const names = new Set(beatmaps.map((beatmap) => normalizeRateVariantVersion(beatmap.version)).filter(Boolean));
  const hasRateVariant = beatmaps.some((beatmap) => parseDifficultyRate(beatmap.version) !== 1);
  if (names.size === 1 && hasRateVariant) return true;
  const keyCounts = new Set(beatmaps.map((beatmap) => Math.round(beatmap.cs)).filter((keyCount) => Number.isFinite(keyCount)));
  return (
    names.size === 0 &&
    hasRateVariant &&
    keyCounts.size <= 1 &&
    beatmaps.every((beatmap) => !/[a-z0-9]/i.test(stripRateVariantDecorations(beatmap.version)))
  );
}

function isLikelyBracketBpmVariantSet(beatmaps: NonNullable<MapsFavouriteBeatmapset["maniaBeatmaps"]>): boolean {
  if (beatmaps.length <= 1) return false;
  const variants = beatmaps
    .map((beatmap) => ({
      bpm: parseBracketBpm(beatmap.version),
      name: normalizeBracketBpmVariantVersion(beatmap.version),
    }))
    .filter((variant) => variant.bpm !== null && variant.name);
  if (variants.length !== beatmaps.length) return false;
  const names = new Set(variants.map((variant) => variant.name));
  const bpms = new Set(variants.map((variant) => variant.bpm));
  return names.size === 1 && bpms.size > 1;
}

function getBracketBpmBase(beatmaps: NonNullable<MapsFavouriteBeatmapset["maniaBeatmaps"]>): number | null {
  const bpms = beatmaps
    .map((beatmap) => parseBracketBpm(beatmap.version))
    .filter((bpm): bpm is number => bpm !== null)
    .sort((a, b) => a - b);
  if (!bpms.length) return null;
  return bpms.includes(130) ? 130 : bpms[0];
}

function isLikelyNumericVariantSet(beatmaps: NonNullable<MapsFavouriteBeatmapset["maniaBeatmaps"]>): boolean {
  if (beatmaps.length <= 1) return false;
  const names = new Set(beatmaps.map((beatmap) => normalizeNumericVariantVersion(beatmap.version)).filter(Boolean));
  if (names.size !== 1) return false;
  return beatmaps.some((beatmap) => /\b\d[\d,.]*\b/.test(beatmap.version));
}

function parseSelectedDifficultyRate(
  selected: NonNullable<MapsFavouriteBeatmapset["maniaBeatmaps"]>[number] | null,
  beatmaps: NonNullable<MapsFavouriteBeatmapset["maniaBeatmaps"]>,
): number {
  if (!selected) return 1;
  const bracketBpm = parseBracketBpm(selected.version);
  const baseBpm = isLikelyBracketBpmVariantSet(beatmaps) ? getBracketBpmBase(beatmaps) : null;
  if (bracketBpm && baseBpm) return bracketBpm / baseBpm;
  return parseDifficultyRate(selected.version);
}

function getSetPreviewReferenceBeatmap(
  beatmaps: NonNullable<MapsFavouriteBeatmapset["maniaBeatmaps"]>,
): NonNullable<MapsFavouriteBeatmapset["maniaBeatmaps"]>[number] | null {
  const meaningfulBeatmaps = beatmaps.filter((beatmap) => beatmap.difficultyRating >= 0.5);
  if (!meaningfulBeatmaps.length) return beatmaps[0] ?? null;

  if (isLikelyBracketBpmVariantSet(meaningfulBeatmaps)) {
    const baseBpm = getBracketBpmBase(meaningfulBeatmaps);
    return meaningfulBeatmaps.find((beatmap) => parseBracketBpm(beatmap.version) === baseBpm) ?? meaningfulBeatmaps[0] ?? null;
  }

  if (isLikelyRateVariantSet(meaningfulBeatmaps)) {
    return meaningfulBeatmaps.find((beatmap) => parseDifficultyRate(beatmap.version) === 1) ?? meaningfulBeatmaps.at(-1) ?? null;
  }

  return null;
}

function isLikelyOrdinaryDifficultySet(beatmaps: NonNullable<MapsFavouriteBeatmapset["maniaBeatmaps"]>): boolean {
  if (beatmaps.length <= 1) return false;
  return beatmaps.every((beatmap) => isOrdinaryDifficultyName(beatmap.version));
}

function isLikelySmallSameSongDifficultySet(beatmaps: NonNullable<MapsFavouriteBeatmapset["maniaBeatmaps"]>): boolean {
  if (beatmaps.length < 2 || beatmaps.length > 4) return false;
  const keyCounts = new Set(beatmaps.map((beatmap) => Math.round(beatmap.cs)).filter((keyCount) => Number.isFinite(keyCount)));
  if (keyCounts.size > 1) return false;
  if (beatmaps.some((beatmap) => looksLikeSongPackVersion(beatmap.version))) return false;
  return (
    beatmaps.some((beatmap) => isOrdinaryDifficultyName(beatmap.version)) ||
    beatmaps.every((beatmap) => hasOrdinaryDifficultySuffix(beatmap.version))
  );
}

function getSvVariantMarker(version: string): "sv" | "nsv" | null {
  if (/(^|[^a-z0-9])nsv($|[^a-z0-9])/i.test(version)) return "nsv";
  if (/(^|[^a-z0-9])sv($|[^a-z0-9])/i.test(version)) return "sv";
  return null;
}

function isLikelySvVariantSet(beatmaps: NonNullable<MapsFavouriteBeatmapset["maniaBeatmaps"]>): boolean {
  if (beatmaps.length <= 1) return false;
  const keyCounts = new Set(beatmaps.map((beatmap) => Math.round(beatmap.cs)).filter((keyCount) => Number.isFinite(keyCount)));
  if (keyCounts.size > 1) return false;
  if (beatmaps.some((beatmap) => looksLikeSongPackVersion(beatmap.version))) return false;

  const markers = beatmaps.map((beatmap) => getSvVariantMarker(beatmap.version));
  return markers.every(Boolean) && markers.includes("sv") && markers.includes("nsv");
}

function shouldUseSetPreviewForReplayAudio(beatmaps: NonNullable<MapsFavouriteBeatmapset["maniaBeatmaps"]>): boolean {
  const playableBeatmaps = beatmaps.filter((beatmap) => beatmap.difficultyRating > 0);
  const meaningfulBeatmaps = playableBeatmaps.filter((beatmap) => beatmap.difficultyRating >= 0.5);
  return (
    beatmaps.length <= 1 ||
    playableBeatmaps.length <= 1 ||
    meaningfulBeatmaps.length <= 1 ||
    isLikelyRateVariantSet(meaningfulBeatmaps) ||
    isLikelyBracketBpmVariantSet(meaningfulBeatmaps) ||
    isLikelyNumericVariantSet(meaningfulBeatmaps) ||
    isLikelyOrdinaryDifficultySet(meaningfulBeatmaps) ||
    isLikelySmallSameSongDifficultySet(meaningfulBeatmaps) ||
    isLikelySvVariantSet(meaningfulBeatmaps)
  );
}

function isLikelyTimedRateVariantSet(beatmaps: NonNullable<MapsFavouriteBeatmapset["maniaBeatmaps"]>): boolean {
  const meaningfulBeatmaps = beatmaps.filter((beatmap) => beatmap.difficultyRating >= 0.5);
  return isLikelyRateVariantSet(meaningfulBeatmaps) || isLikelyBracketBpmVariantSet(meaningfulBeatmaps);
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

function matchesSearch(query: string, fields: Array<string | null | undefined>): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return fields.some((field) => (field ?? "").toLowerCase().includes(q));
}

function normalizeRandomForceSearch(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function matchesRandomForceSearch(
  pair: { player: MapsPlayerFavourites; beatmapset: MapsFavouriteBeatmapset },
  query: string,
): boolean {
  const tokens = normalizeRandomForceSearch(query).split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return false;

  const beatmapset = pair.beatmapset;
  const haystack = normalizeRandomForceSearch([
    beatmapset.id,
    beatmapset.title,
    beatmapset.artist,
    beatmapset.creator,
    beatmapset.status,
    pair.player.username,
    ...(beatmapset.patterns ?? []),
    ...(beatmapset.maniaKeys ?? []).map((key) => `${key}k`),
    ...(beatmapset.maniaBeatmaps ?? []).flatMap((beatmap) => [
      beatmap.id,
      beatmap.version,
      `${Math.round(beatmap.cs)}k`,
      beatmap.difficultyRating.toFixed(2),
    ]),
  ].join(" "));

  return tokens.every((token) => haystack.includes(token));
}

function getLatestFarmedPlayTime(entry: MapsFarmedEntry): number {
  return entry.players.reduce((latest, player) => {
    const time = new Date(player.playedAt ?? 0).getTime();
    return Number.isFinite(time) ? Math.max(latest, time) : latest;
  }, 0);
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
      !Array.isArray(sampleSet.maniaBeatmaps) ||
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
        (samplePlayer.scoreUrl !== null && typeof samplePlayer.scoreUrl !== "string") ||
        (samplePlayer.playedAt !== null && typeof samplePlayer.playedAt !== "string")
      )
    ) {
      return false;
    }
  }

  return true;
}

// ── Route ──────────────────────────────────────────────────────────────────

export const Route = createFileRoute("/maps")({
  head: ({ match }) => {
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
    tab: search.tab === "popular" || search.tab === "favourites" || search.tab === "random" ? search.tab : DEFAULT_MAPS_SEARCH.tab,
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
  const rankings = useAppStore((s) => s.rankingsByCountry[selectedCountry] ?? null);
  const rankingsFetchedAt = useAppStore((s) => s.rankingsFetchedAtByCountry[selectedCountry] ?? null);
  const mapsData = useAppStore((s) => s.mapsDataByCountry[selectedCountry] ?? null);
  const setRankings = useAppStore((s) => s.setRankings);
  const setMapsData = useAppStore((s) => s.setMapsData);
  const hiddenUserIds = useHiddenUserIds();
  const hasValidMapsData = hasValidMapsDataShape(mapsData);

  const [loadingPlayers, setLoadingPlayers] = useState(!rankings);
  const [loadingMaps, setLoadingMaps] = useState(!mapsData);
  const [loadedSections, setLoadedSections] = useState(0);
  const [smoothProgress, setSmoothProgress] = useState(0);
  const [rebuilding, setRebuilding] = useState(false);
  const [rebuildMenuOpen, setRebuildMenuOpen] = useState(false);
  const [rebuildQuery, setRebuildQuery] = useState("");
  const [liveMapsAttempted, setLiveMapsAttempted] = useState(false);
  const [liveMapsRefreshing, setLiveMapsRefreshing] = useState(false);
  const [liveMapsPage, setLiveMapsPage] = useState<LiveMapsPageState | null>(null);
  const liveMapsPageCacheRef = useRef<Map<string, LiveMapsPageState>>(liveMapsPageSessionCache);
  const liveMapsPageTotalCacheRef = useRef<Map<string, number>>(liveMapsPageTotalSessionCache);
  // True while the live backend is building this country's maps for the very
  // first time (no snapshot has ever existed). Distinguishes a cold first build
  // from a quick refresh of already-cached maps.
  const [mapsFirstBuild, setMapsFirstBuild] = useState(false);
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
  const [detailsOpen, setDetailsOpen] = useState<MapDetails | null>(null);
  const fetchingMapsRef = useRef(false);
  const tab = mapsSearch.tab;
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
  const isDevMode = auth.canUseDevFeatures;
  const canUseAdminFeatures = auth.canUseAdminFeatures;
  const liveBackendEnabled = isLiveBackendConfigured();
  const { warming } = useCountryWarming(selectedCountry);
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
  const liveMapsBrowseTab = tab === "random" ? null : (tab as LiveMapsBrowseTab);
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
    setLoadingPlayers(liveBackendEnabled ? false : !rankings);
    setLoadingMaps(liveBackendEnabled ? false : !mapsData || !hasValidMapsData);
    setLoadedSections(0);
    setSmoothProgress(0);
    setError(null);
    setLiveMapsAttempted(false);
    setLiveMapsRefreshing(false);
    setLiveMapsPage(null);
    fetchingMapsRef.current = false;
  }, [selectedCountry, liveBackendEnabled]);

  useEffect(() => {
    if (!loadingMaps) {
      setSmoothProgress(0);
      return;
    }
    const realPercent = loadedSections * 50;
    setSmoothProgress((prev) => Math.max(prev, realPercent));
    const cap = Math.min(realPercent + 45, 95);
    const id = setInterval(() => {
      setSmoothProgress((prev) => {
        if (prev >= cap) return prev;
        return Math.min(cap, prev + Math.max(1, (cap - prev) * 0.1));
      });
    }, 180);
    return () => clearInterval(id);
  }, [loadingMaps, loadedSections]);

  useEffect(() => {
    if (!liveBackendEnabled) return;
    if (!liveMapsPageParams || !liveMapsPageRequestKey) return;

    setLiveMapsAttempted(false);
    setMapsFirstBuild(false);
    let cancelled = false;
    const cachedPage = liveMapsPageCacheRef.current.get(liveMapsPageRequestKey) ?? null;
    setLoadingMaps(!cachedPage);
    setLoadedSections(cachedPage ? 2 : 0);
    let pollTimer: ReturnType<typeof setTimeout> | null = null;

    const loadPage = () => {
      fetchLiveMapsPageSnapshot(selectedCountry, liveMapsPageParams)
        .then((snapshot) => {
          if (cancelled) return;
          setLiveMapsRefreshing(snapshot.isStale || snapshot.refreshQueued);
          if (snapshot.value) {
            rememberLiveMapsPage({ ...snapshot.value, requestKey: liveMapsPageRequestKey });
            setLoadedSections(2);
            setLoadingMaps(false);
            setMapsFirstBuild(false);
            setError(null);
          } else if (!cachedPage) {
            setLiveMapsPage(null);
            setLoadingMaps(true);
            setMapsFirstBuild(snapshot.generatedAt == null);
          }
          if (!cancelled && (snapshot.isStale || snapshot.refreshQueued)) {
            pollTimer = setTimeout(loadPage, 5_000);
          }
        })
        .catch(() => {
          if (!cancelled) {
            setLoadingMaps(false);
            if (!cachedPage) setError("Couldn't load maps data. Try again later.");
          }
          if (!cancelled) setLiveMapsRefreshing(false);
        })
        .finally(() => {
          if (!cancelled) setLiveMapsAttempted(true);
        });
    };

    loadPage();

    return () => {
      cancelled = true;
      if (pollTimer) clearTimeout(pollTimer);
    };
  }, [liveBackendEnabled, liveMapsPageParams, liveMapsPageRequestKey, rememberLiveMapsPage, selectedCountry]);

  useEffect(() => {
    if (!liveBackendEnabled) return;
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
  }, [liveBackendEnabled, liveMapsPageParams, liveMapsPageRequestKey, rememberLiveMapsPage, selectedCountry]);

  // The Random tab still needs the heavy beatmapsetsPool, so it is fetched
  // only when Random is opened. Normal map browsing uses the paged endpoint.
  const randomPoolReady = useMemo(() => {
    if (!mapsData) return false;
    if (!mapsData.favouritesByPlayer || mapsData.favouritesByPlayer.length === 0) return true;
    return !!mapsData.beatmapsetsPool && Object.keys(mapsData.beatmapsetsPool).length > 0;
  }, [mapsData]);

  useEffect(() => {
    if (!liveBackendEnabled || tab !== "random") return;
    setLiveMapsAttempted(false);
    if (randomPoolReady) {
      setLoadingMaps(false);
      setLoadedSections(2);
      return;
    }

    let cancelled = false;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    setLoadingMaps(true);
    setLoadedSections(0);

    const loadRandomPool = () => {
      fetchLiveMapsSnapshot(selectedCountry, "random")
        .then((snapshot) => {
          if (cancelled) return;
          setLiveMapsRefreshing(snapshot.isStale || snapshot.refreshQueued);
          if (snapshot.value && hasValidMapsDataShape(snapshot.value)) {
            setMapsData(selectedCountry, snapshot.value);
            setLoadedSections(2);
            setLoadingMaps(false);
            setMapsFirstBuild(false);
            setError(null);
          } else {
            setLoadingMaps(true);
            setMapsFirstBuild(snapshot.generatedAt == null);
          }
          if (!cancelled && (snapshot.isStale || snapshot.refreshQueued)) {
            pollTimer = setTimeout(loadRandomPool, 5_000);
          }
        })
        .catch(() => {
          if (!cancelled) {
            setLoadingMaps(false);
            setLiveMapsRefreshing(false);
            setError("Couldn't load maps data. Try again later.");
          }
        })
        .finally(() => {
          if (!cancelled) setLiveMapsAttempted(true);
        });
    };

    loadRandomPool();

    return () => {
      cancelled = true;
      if (pollTimer) clearTimeout(pollTimer);
    };
  }, [liveBackendEnabled, randomPoolReady, selectedCountry, setMapsData, tab]);

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
    if (liveBackendEnabled) {
      setLoadingPlayers(false);
      return () => { cancelled = true; };
    }
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
  }, [liveBackendEnabled, rankings, rankingsFetchedAt, selectedCountry, setRankings]);

  // Fetch maps data in two parallel sections (farmed + favourites) so the
  // header can show incremental progress. We intentionally exclude mapsData /
  // hasValidMapsData / mapsDataFetchedAt from the dep array: those are derived
  // from the store this effect writes to, and including them would make the
  // effect re-trigger itself on every setMapsData and race with the cleanup.
  // fetchingMapsRef guards against concurrent fetches for the same country.
  useEffect(() => {
    if (liveBackendEnabled) return;
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
  }, [loadingPlayers, error, playerIdsKey, selectedCountry, liveBackendEnabled, liveMapsAttempted]);

  // ── Filtered + sorted: farmed (from best scores) ────────────────────────
  // Maps data is aggregate (per-map player lists). Strip hidden players from
  // every player list once here and recompute the derived counts, so the
  // farmed/popular/favourites/random views all read already-cleaned data.
  const visibleMapsData = useMemo<CountryMapsData | null>(() => {
    if (!mapsData) return null;
    if (liveBackendPaged && tab !== "random") return mapsData;
    if (hiddenUserIds.size === 0) return mapsData;

    const farmed = mapsData.farmed
      .map((entry) => {
        const players = entry.players.filter((p) => !hiddenUserIds.has(p.id));
        if (players.length === entry.players.length) return entry;
        if (players.length === 0) return null;
        return {
          ...entry,
          players,
          playerCount: players.length,
          avgPp: players.reduce((sum, p) => sum + p.pp, 0) / players.length,
          maxPp: Math.max(...players.map((p) => p.pp), 0),
        };
      })
      .filter((entry): entry is MapsFarmedEntry => entry !== null);

    const mostPlayed = mapsData.mostPlayed
      .map((entry) => {
        const players = entry.players.filter((p) => !hiddenUserIds.has(p.id));
        if (players.length === entry.players.length) return entry;
        if (players.length === 0) return null;
        return {
          ...entry,
          players,
          playerCount: players.length,
          totalPlays: players.reduce((sum, p) => sum + p.count, 0),
        };
      })
      .filter((entry): entry is MapsAggregatedBeatmap => entry !== null);

    const favourites = mapsData.favourites
      .map((entry) => {
        const players = entry.players.filter((p) => !hiddenUserIds.has(p.id));
        if (players.length === entry.players.length) return entry;
        if (players.length === 0) return null;
        return { ...entry, players, playerCount: players.length };
      })
      .filter((entry): entry is MapsAggregatedFavourite => entry !== null);

    const favouritesByPlayer = mapsData.favouritesByPlayer.filter(
      (player) => !hiddenUserIds.has(player.id),
    );

    return { ...mapsData, farmed, mostPlayed, favourites, favouritesByPlayer };
  }, [mapsData, hiddenUserIds, liveBackendPaged, tab]);

  const filteredFarmed = useMemo(() => {
    if (liveBackendPaged || tab !== "farmed") return [];
    if (!visibleMapsData?.farmed?.length) return [];
    return visibleMapsData.farmed
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
          matchesSearch(searchQuery, [m.title, m.artist, m.creator, m.version]) &&
          (modFilter === "all" || (
            modFilter === "dt" ? getDominantSpeedMod(m.players) === "DT" :
            modFilter === "ht" ? getDominantSpeedMod(m.players) === "HT" :
            getDominantSpeedMod(m.players) === null
          )),
      )
      .sort((a, b) => {
        const flip = sortDir === "asc" ? -1 : 1;
        if (farmedSort === "players") return (b.playerCount - a.playerCount) * flip || b.avgPp - a.avgPp;
        if (farmedSort === "avg-pp") return (b.avgPp - a.avgPp) * flip;
        if (farmedSort === "max-pp") return (b.maxPp - a.maxPp) * flip;
        if (farmedSort === "recent") {
          return (getLatestFarmedPlayTime(b) - getLatestFarmedPlayTime(a)) * flip || b.playerCount - a.playerCount || b.avgPp - a.avgPp;
        }
        return (b.difficultyRating - a.difficultyRating) * flip;
      });
  }, [visibleMapsData, keyFilter, searchQuery, farmedSort, sortDir, ppFilter, modFilter, liveBackendPaged, tab]);

  // ── Filtered + sorted: most played (from most_played endpoint) ──────────
  const filteredMostPlayed = useMemo(() => {
    if (liveBackendPaged || tab !== "popular") return [];
    if (!visibleMapsData?.mostPlayed?.length) return [];
    return visibleMapsData.mostPlayed
      .filter(
        (m) =>
          matchesKeyFilter(parseKeyCount(m.version), keyFilter) &&
          matchesSearch(searchQuery, [m.title, m.artist, m.creator, m.version]),
      )
      .sort((a, b) => {
        const flip = sortDir === "asc" ? -1 : 1;
        if (beatmapSort === "plays") return (b.totalPlays - a.totalPlays) * flip;
        if (beatmapSort === "players") return (b.playerCount - a.playerCount) * flip || b.totalPlays - a.totalPlays;
        if (beatmapSort === "stars") return (b.difficultyRating - a.difficultyRating) * flip;
        return (b.totalLength - a.totalLength) * flip;
      });
  }, [visibleMapsData, keyFilter, searchQuery, beatmapSort, sortDir, liveBackendPaged, tab]);

  // ── Filtered + sorted: favourites ───────────────────────────────────────
  const filteredFavourites = useMemo(() => {
    if (liveBackendPaged || tab !== "favourites") return [];
    if (!visibleMapsData?.favourites?.length) return [];
    return visibleMapsData.favourites
      .filter(
        (f) =>
          matchesStatusFilter(f.status, statusFilter) &&
          matchesSearch(searchQuery, [f.title, f.artist, f.creator]),
      )
      .sort(
        (a, b) =>
          b.playerCount - a.playerCount || b.globalFavouriteCount - a.globalFavouriteCount,
      );
  }, [visibleMapsData, statusFilter, searchQuery, liveBackendPaged, tab]);

  const liveVisiblePageItems = useMemo(() => {
    if (!currentLiveMapsPage) return [];
    if (hiddenUserIds.size === 0) return currentLiveMapsPage.items;

    if (currentLiveMapsPage.tab === "farmed") {
      return (currentLiveMapsPage.items as MapsFarmedEntry[])
        .map((entry) => {
          const players = entry.players.filter((p) => !hiddenUserIds.has(p.id));
          if (players.length === entry.players.length) return entry;
          if (players.length === 0) return null;
          return {
            ...entry,
            players,
            playerCount: players.length,
            avgPp: players.reduce((sum, p) => sum + p.pp, 0) / players.length,
            maxPp: Math.max(...players.map((p) => p.pp), 0),
          };
        })
        .filter((entry): entry is MapsFarmedEntry => entry !== null);
    }

    if (currentLiveMapsPage.tab === "popular") {
      return (currentLiveMapsPage.items as MapsAggregatedBeatmap[])
        .map((entry) => {
          const players = entry.players.filter((p) => !hiddenUserIds.has(p.id));
          if (players.length === entry.players.length) return entry;
          if (players.length === 0) return null;
          return {
            ...entry,
            players,
            playerCount: players.length,
            totalPlays: players.reduce((sum, p) => sum + p.count, 0),
          };
        })
        .filter((entry): entry is MapsAggregatedBeatmap => entry !== null);
    }

    return (currentLiveMapsPage.items as MapsAggregatedFavourite[])
      .map((entry) => {
        const players = entry.players.filter((p) => !hiddenUserIds.has(p.id));
        if (players.length === entry.players.length) return entry;
        if (players.length === 0) return null;
        return { ...entry, players, playerCount: players.length };
      })
      .filter((entry): entry is MapsAggregatedFavourite => entry !== null);
  }, [currentLiveMapsPage, hiddenUserIds]);

  const currentList =
    liveBackendPaged
      ? liveVisiblePageItems
      : tab === "farmed"
      ? filteredFarmed
      : tab === "popular"
        ? filteredMostPlayed
        : tab === "favourites"
          ? filteredFavourites
          : [];
  const currentTotal = liveBackendPaged ? (currentLiveMapsPage?.total ?? 0) : currentList.length;
  const totalPages = tab === "random" ? 0 : Math.ceil(currentTotal / PAGE_SIZE);
  const paginationTotal = liveBackendPaged ? knownLiveMapsTotal : currentTotal;
  const paginationTotalPages = tab === "random" ? 0 : Math.ceil(paginationTotal / PAGE_SIZE);
  const currentRawListLength =
    liveBackendPaged
      ? currentTotal
      : tab === "farmed"
      ? mapsData?.farmed.length ?? 0
      : tab === "popular"
        ? mapsData?.mostPlayed.length ?? 0
        : tab === "favourites"
          ? mapsData?.favourites.length ?? 0
          : 0;
  const currentMapsSectionLoading =
    liveBackendEnabled &&
    liveMapsRefreshing &&
    tab !== "random" &&
    !liveBackendPaged &&
    !!mapsData &&
    currentRawListLength === 0;
  const currentMapsSectionLabel =
    tab === "farmed"
      ? "most farmed"
      : tab === "popular"
        ? "widely played"
        : "community favorites";

  useEffect(() => {
    if (tab === "random" || totalPages === 0 || page < totalPages) return;
    updateMapsSearch({ page: totalPages - 1 });
  }, [page, tab, totalPages]);

  const paginated = tab === "random" ? [] : liveBackendPaged ? currentList : currentList.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  const tabs: { id: Tab; label: string }[] = [
    { id: "farmed", label: "most farmed" },
    { id: "popular", label: "widely played" },
    { id: "favourites", label: "community favorites" },
    { id: "random", label: "random picks" },
  ];

  const isLoading = loadingPlayers || (liveBackendPaged ? liveMapsPagePending : loadingMaps) || currentMapsSectionLoading;

  // ── Random tab: pick a random top-50 player and a single random favourite ──
  // The pool ships lean entries, so a pick records the chosen set id and the
  // full record (covers + per-difficulty list + preview audio) is fetched on
  // demand, cached, and prefetched a few ahead so rerolls stay snappy.
  const [randomPlayer, setRandomPlayer] = useState<MapsPlayerFavourites | null>(null);
  const [pickedSetId, setPickedSetId] = useState<number | null>(null);
  const [randomBeatmapset, setRandomBeatmapset] = useState<MapsFavouriteBeatmapset | null>(null);
  const fullSetCacheRef = useRef<Map<number, MapsFavouriteBeatmapset>>(new Map());
  const lastRandomKeyRef = useRef<string | null>(null);
  // Sliding windows used when "avoid repeats" is on (see reshuffleRandom).
  const recentRandomPlayerIdsRef = useRef<number[]>([]);
  const recentRandomBeatmapIdsRef = useRef<number[]>([]);
  const [rerollMenuOpen, setRerollMenuOpen] = useState(false);
  const [devRandomForceQuery, setDevRandomForceQuery] = useState("");
  const [devRandomForceOpen, setDevRandomForceOpen] = useState(false);
  const rerollMenuRef = useRef<HTMLDivElement | null>(null);
  const devRandomForceRef = useRef<HTMLDivElement | null>(null);
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

  useEffect(() => {
    if (!devRandomForceOpen) return;
    const onDown = (e: MouseEvent) => {
      if (devRandomForceRef.current && !devRandomForceRef.current.contains(e.target as Node)) {
        setDevRandomForceOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [devRandomForceOpen]);

  useEffect(() => {
    if (tab !== "random" || devRandomForceQuery.trim().length < 2) {
      setDevRandomForceOpen(false);
    }
  }, [devRandomForceQuery, tab]);

  // ── Mobile collapsible filter panel (shared across tabs) ────────────────
  const [filtersOpen, setFiltersOpen] = useState(false);
  const activeFilterCount = useMemo(() => {
    if (tab === "random") return totalRandomActive;
    if (tab === "farmed") {
      return (
        (keyFilter !== "all" ? 1 : 0) +
        (modFilter !== "all" ? 1 : 0) +
        (ppFilter > 0 ? 1 : 0) +
        (farmedSort !== "players" || sortDir !== "desc" ? 1 : 0)
      );
    }
    if (tab === "popular") {
      return (keyFilter !== "all" ? 1 : 0) + (beatmapSort !== "players" || sortDir !== "desc" ? 1 : 0);
    }
    if (tab === "favourites") return statusFilter !== "all" ? 1 : 0;
    return 0;
  }, [tab, totalRandomActive, keyFilter, modFilter, ppFilter, farmedSort, beatmapSort, sortDir, statusFilter]);

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
    if (tab !== "random") return [];
    if (!visibleMapsData?.favouritesByPlayer || !visibleMapsData?.beatmapsetsPool) return [];
    const pairs: Array<{ player: MapsPlayerFavourites; beatmapset: MapsFavouriteBeatmapset }> = [];
    for (const player of visibleMapsData.favouritesByPlayer) {
      for (const bid of player.beatmapsetIds) {
        const beatmapset = visibleMapsData.beatmapsetsPool[bid];
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
  }, [visibleMapsData, randomStatus, randomKey, randomPatternCanonical, rStars, rStarsMax, tab]);
  const randomUniqueBeatmapsetCount = useMemo(
    () => new Set(randomPool.map((pair) => pair.beatmapset.id)).size,
    [randomPool],
  );

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

  const devRandomForceMatches = useMemo(() => {
    if (!isDevMode || tab !== "random" || devRandomForceQuery.trim().length < 2) return [];
    return randomPool
      .filter((pair) => matchesRandomForceSearch(pair, devRandomForceQuery))
      .slice(0, 12);
  }, [devRandomForceQuery, isDevMode, randomPool, tab]);

  // Prefetch + cache full set records so most rerolls resolve instantly.
  const warmRandomSetCache = useCallback((ids: number[]) => {
    if (!liveBackendEnabled) return;
    const need = [...new Set(ids)]
      .filter((id) => Number.isFinite(id) && id > 0 && !fullSetCacheRef.current.has(id))
      .slice(0, 10);
    if (need.length === 0) return;
    fetchLiveMapsBeatmapsets(selectedCountry, need)
      .then((sets) => { for (const set of sets) fullSetCacheRef.current.set(set.id, set); })
      .catch(() => undefined);
  }, [liveBackendEnabled, selectedCountry]);

  const forceDevRandomPick = useCallback((pair: { player: MapsPlayerFavourites; beatmapset: MapsFavouriteBeatmapset }) => {
    setRandomPlayer(pair.player);
    setPickedSetId(pair.beatmapset.id);
    setDevRandomForceOpen(false);
  }, []);

  const reshuffleRandom = useCallback(() => {
    if (randomPlayerGroups.length === 0) {
      setRandomPlayer(null);
      setPickedSetId(null);
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
    setPickedSetId(pickedBeatmapset.id);
    // Warm a few upcoming candidates so the next rerolls don't wait on a fetch.
    if (randomPool.length > 1) {
      const sample: number[] = [];
      for (let i = 0; i < 6; i++) {
        sample.push(randomPool[Math.floor(Math.random() * randomPool.length)].beatmapset.id);
      }
      warmRandomSetCache(sample);
    }
  }, [randomPlayerGroups, randomPool, rWeight, rAvoidRepeats, warmRandomSetCache]);

  // Resolve the picked set's full record (covers + per-difficulty list + preview
  // audio) on demand. Cached and prefetched entries resolve synchronously; the
  // non-live fallback path already ships full pool entries, so use them as-is.
  useEffect(() => {
    if (pickedSetId == null) {
      setRandomBeatmapset(null);
      return;
    }
    const poolSet = visibleMapsData?.beatmapsetsPool?.[pickedSetId] ?? null;
    if (poolSet && poolSet.maniaBeatmaps.length > 0) {
      setRandomBeatmapset(poolSet);
      return;
    }
    const cached = fullSetCacheRef.current.get(pickedSetId);
    if (cached) {
      setRandomBeatmapset(cached);
      return;
    }
    if (!liveBackendEnabled) {
      setRandomBeatmapset(poolSet);
      return;
    }
    let cancelled = false;
    setRandomBeatmapset(null);
    fetchLiveMapsBeatmapsets(selectedCountry, [pickedSetId])
      .then((sets) => {
        if (cancelled) return;
        const full = sets.find((set) => set.id === pickedSetId) ?? null;
        if (full) fullSetCacheRef.current.set(pickedSetId, full);
        setRandomBeatmapset(full ?? poolSet);
      })
      .catch(() => {
        if (!cancelled) setRandomBeatmapset(poolSet);
      });
    return () => { cancelled = true; };
  }, [pickedSetId, liveBackendEnabled, selectedCountry, visibleMapsData]);

  // Only reshuffle on first entry to the tab or when the underlying data
  // changes (country switch / rebuild). Filter changes never auto-reroll —
  // the user must click Reroll explicitly.
  useEffect(() => {
    if (tab !== "random" || !mapsData) return;
    const dataKey = `${selectedCountry}:${mapsData.favouritesGeneratedAt}`;
    const dataChanged = lastRandomKeyRef.current !== dataKey;
    lastRandomKeyRef.current = dataKey;
    if (dataChanged || pickedSetId == null) reshuffleRandom();
  }, [tab, selectedCountry, mapsData, reshuffleRandom, pickedSetId]);

  const hasActiveFilters =
    tab === "random"
      ? totalRandomActive > 0
      : (
          searchQuery || keyFilter !== "all" || statusFilter !== "all" || ppFilter > 0 || modFilter !== "all" || beatmapSort !== "players" || farmedSort !== "players" || sortDir !== "desc" || tab !== "farmed"
        );

  const resetFilters = () => {
    navigate({
      to: "/maps",
      search: { ...DEFAULT_MAPS_SEARCH, tab, country: mapsSearch.country },
      replace: true,
      resetScroll: false,
    });
  };

  const handleDevRebuildAll = async () => {
    if (rebuilding || (!liveBackendEnabled && players.length === 0)) return;
    setRebuilding(true);
    setRebuildMenuOpen(false);
    try {
      if (liveBackendEnabled) {
        await runLiveBackendAdminAction({ data: { path: `/api/admin/refresh-maps?country=${selectedCountry}` } });
        if (tab === "random") {
          const snapshot = await fetchLiveMapsSnapshot(selectedCountry, "random");
          if (snapshot.value && hasValidMapsDataShape(snapshot.value)) {
            setMapsData(selectedCountry, snapshot.value);
          }
        } else if (liveMapsPageParams && liveMapsPageRequestKey) {
          const snapshot = await fetchLiveMapsPageSnapshot(selectedCountry, liveMapsPageParams);
          if (snapshot.value) {
            liveMapsPageCacheRef.current.clear();
            rememberLiveMapsPage({ ...snapshot.value, requestKey: liveMapsPageRequestKey });
          }
        }
        return;
      }
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

  const mapsUpdatedAt =
    tab === "farmed"
      ? currentLiveMapsPage?.farmedGeneratedAt ?? mapsData?.farmedGeneratedAt
      : currentLiveMapsPage?.favouritesGeneratedAt ?? mapsData?.favouritesGeneratedAt;
  const showMapsSummary =
    !isLoading &&
    !error &&
    (tab === "random"
      ? !!mapsData && randomPoolReady
      : liveBackendPaged
        ? !!currentLiveMapsPage
        : !!mapsData);

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
                    : currentMapsSectionLoading
                      ? `Loading ${currentMapsSectionLabel}...`
                      : mapsFirstBuild
                      ? "Building maps..."
                      : `Loading maps... (${Math.round(smoothProgress)}%)`}
                </span>
              </div>
            )}
            {showMapsSummary && mapsUpdatedAt && (
              <span className="text-[10px] text-osu-f1">
                {tab === "random"
                  ? `${formatNumber(randomPool.length)} possible picks · ${formatNumber(randomUniqueBeatmapsetCount)} unique sets`
                  : `${formatNumber(currentTotal)} maps`} &middot; updated {formatTimeAgo(mapsUpdatedAt)}
              </span>
            )}
            {canUseAdminFeatures && !isLoading && !error && (mapsData || currentLiveMapsPage) && (
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

      {warming && <CountryWarming country={selectedCountry} />}

      {!warming && (
      <>
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
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Search maps..."
              aria-label="Search by title, artist, mapper, or difficulty"
              title="Search by title, artist, mapper, or difficulty"
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
                {formatNumber(randomPool.length)} {randomPool.length === 1 ? "pick" : "possible picks"}
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
                        onContextMenu={() => updateMapsSearch({ rStatus: reverseCycleTriStateCsv(rStatusRaw, s) })}
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
                        onContextMenu={() => updateMapsSearch({ rKey: reverseCycleTriStateCsv(rKeyRaw, k) })}
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
                        onContextMenu={() => updateMapsSearch({ rPattern: reverseCycleTriStateCsv(rPatternRaw, p) })}
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
                    {formatNumber(randomPool.length)} {randomPool.length === 1 ? "pick" : "possible picks"}
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
                      ["recent", "Recent Plays"],
                    ] as [FarmedSort, string][]).map(([id, label]) => (
                      <SortPill
                        key={id}
                        active={farmedSort === id}
                        dir={sortDir}
                        onClick={() => {
                          const nextDir: SortDirection = farmedSort === id ? (sortDir === "desc" ? "asc" : "desc") : "desc";
                          updateMapsSearch({ farmedSort: id, dir: nextDir, page: 0 });
                        }}
                      >
                        {label}
                      </SortPill>
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
                      <SortPill
                        key={id}
                        active={beatmapSort === id}
                        dir={sortDir}
                        onClick={() => {
                          const nextDir: SortDirection = beatmapSort === id ? (sortDir === "desc" ? "asc" : "desc") : "desc";
                          updateMapsSearch({ beatmapSort: id, dir: nextDir, page: 0 });
                        }}
                      >
                        {label}
                      </SortPill>
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

          {/* Loading skeleton */}
          {!error && isLoading && (liveBackendPaged ? !currentLiveMapsPage : (!mapsData || !hasValidMapsData)) && (
            <div className="space-y-3">
              {mapsFirstBuild && !loadingPlayers && (
                <div className="rounded-lg border border-osu-b3/30 bg-osu-b4/60 px-3.5 py-2.5 text-[11px] leading-relaxed text-osu-f1">
                  <span className="font-semibold text-osu-c2">First time loading {countryName} maps.</span>{" "}
                  Scanning its top players' plays and favourites. This can take a minute, and the page will fill in on its own.
                </div>
              )}
              <MapsLoadingIndicator loadingPlayers={loadingPlayers} firstBuild={mapsFirstBuild} />
              {tab === "random" ? (
                <RandomPickLoadingSkeleton />
              ) : (
                <MapsCardGridSkeleton count={PAGE_SIZE} />
              )}
            </div>
          )}

          {!error && currentMapsSectionLoading && mapsData && hasValidMapsData && (
            <div className="space-y-3">
              <div className="rounded-lg border border-osu-b3/30 bg-osu-b4/60 px-3.5 py-2.5 text-[11px] leading-relaxed text-osu-f1">
                <span className="font-semibold text-osu-c2">Still loading {currentMapsSectionLabel}.</span>{" "}
                The other map tabs may appear first while this section catches up.
              </div>
              <MapsLoadingIndicator loadingPlayers={false} firstBuild={false} label={`Loading ${currentMapsSectionLabel}...`} />
              <MapsCardGridSkeleton count={8} />
            </div>
          )}

          {/* Card grid */}
          {tab !== "random" && !error && !currentMapsSectionLoading && paginated.length > 0 && (
            <div key={`${tab}-${page}`} className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3 cards-enter">
                {tab === "farmed"
                  ? (paginated as MapsFarmedEntry[]).map((map) => (
                      <FarmedCard
                        key={map.beatmapId}
                        map={map}
                        onPlayerClick={(u) => navigate({ to: "/player/$username", params: { username: u } })}
                        onOpenDetails={() => setDetailsOpen({ kind: "farmed", map })}
                      />
                    ))
                  : tab === "popular"
                    ? (paginated as MapsAggregatedBeatmap[]).map((map) => (
                        <MostPlayedCard
                          key={map.beatmapId}
                          map={map}
                          onPlayerClick={(u) => navigate({ to: "/player/$username", params: { username: u } })}
                          onOpenDetails={() => setDetailsOpen({ kind: "popular", map })}
                        />
                      ))
                    : (paginated as MapsAggregatedFavourite[]).map((fav) => (
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

          {/* Random tab — pool still loading in the background */}
          {tab === "random" && !error && !isLoading && !currentMapsSectionLoading && mapsData && !randomPoolReady && (
            <RandomPickLoadingSkeleton />
          )}

          {/* Random tab */}
          {tab === "random" && !error && !isLoading && mapsData && randomPoolReady && (
            <div className="max-w-[640px] mx-auto space-y-5">
              {isDevMode ? (
                <div ref={devRandomForceRef} className="relative z-30 rounded-lg border border-osu-yellow/25 bg-osu-yellow/10 p-2.5">
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      const first = devRandomForceMatches[0];
                      if (!first) return;
                      forceDevRandomPick(first);
                    }}
                    className="flex flex-col gap-2"
                  >
                    <div className="flex items-center gap-2">
                      <span className="shrink-0 rounded bg-osu-yellow/20 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-osu-yellow">
                        Dev
                      </span>
                      <input
                        type="text"
                        value={devRandomForceQuery}
                        onChange={(e) => {
                          setDevRandomForceQuery(e.target.value);
                          setDevRandomForceOpen(e.target.value.trim().length >= 2);
                        }}
                        onFocus={() => setDevRandomForceOpen(devRandomForceQuery.trim().length >= 2)}
                        placeholder="Force random pick..."
                        className="min-w-0 flex-1 rounded-md border border-osu-yellow/25 bg-osu-b5/70 px-2 py-1.5 text-[11px] text-osu-l2 placeholder:text-osu-f1 focus:outline-none focus:border-osu-yellow/50"
                      />
                      <button
                        type="submit"
                        disabled={devRandomForceMatches.length === 0}
                        className="rounded-md bg-osu-yellow/20 px-2.5 py-1.5 text-[11px] font-semibold text-osu-yellow transition-colors hover:bg-osu-yellow/30 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        Force
                      </button>
                    </div>
                    {devRandomForceOpen && devRandomForceQuery.trim().length >= 2 ? (
                      <div className="absolute left-2.5 right-2.5 top-[calc(100%-0.35rem)] max-h-[260px] overflow-y-auto rounded-md border border-osu-b3/40 bg-osu-b5/95 shadow-2xl backdrop-blur-sm">
                        {devRandomForceMatches.length > 0 ? devRandomForceMatches.map(({ player, beatmapset }) => (
                          <button
                            key={`${player.id}-${beatmapset.id}`}
                            type="button"
                            onClick={() => forceDevRandomPick({ player, beatmapset })}
                            className="flex w-full items-center gap-2 px-2 py-1.5 text-left transition-colors hover:bg-osu-b3/70"
                          >
                            <img
                              src={beatmapset.covers.list ?? beatmapset.covers.card}
                              alt=""
                              className="h-8 w-12 shrink-0 rounded object-cover"
                              loading="lazy"
                            />
                            <div className="min-w-0 flex-1">
                              <div className="truncate text-[11px] font-semibold text-osu-l2">
                                {beatmapset.title}
                              </div>
                              <div className="truncate text-[10px] text-osu-f1">
                                {beatmapset.artist}{" \u00b7 "}{beatmapset.creator}{" \u00b7 "}{player.username}
                              </div>
                            </div>
                            <span className="shrink-0 text-[10px] font-semibold text-osu-yellow">
                              {"\u2605"}{formatStars(beatmapset) ?? "?"}
                            </span>
                          </button>
                        )) : (
                          <div className="px-2 py-2 text-[10px] text-osu-f1">
                            No matches in the current random pool.
                          </div>
                        )}
                      </div>
                    ) : null}
                  </form>
                </div>
              ) : null}

              {randomPlayer ? (
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
                              Makes recent picks much less likely.
                            </div>
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                  {randomBeatmapset ? (
                    <div key={`random-${randomPlayer.id}-${pickedSetId}`} className="cards-enter">
                      <RandomCard bm={randomBeatmapset} />
                    </div>
                  ) : (
                    <RandomCardSkeleton />
                  )}
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
          {tab !== "random" && !currentMapsSectionLoading && paginationTotalPages > 1 && (
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

      <MapDetailsModal
        details={detailsOpen}
        country={selectedCountry}
        onClose={() => setDetailsOpen(null)}
      />
    </div>
  );
}

// ── Loading indicator ─────────────────────────────────────────────────────

const LOADING_STEPS = [
  "Loading maps...",
  "Almost there...",
];

function MapsLoadingIndicator({ loadingPlayers, firstBuild, label: overrideLabel }: { loadingPlayers: boolean; firstBuild: boolean; label?: string }) {
  const [stepIndex, setStepIndex] = useState(0);

  useEffect(() => {
    if (loadingPlayers || firstBuild) return;
    const id = setInterval(() => {
      setStepIndex((i) => (i + 1) % LOADING_STEPS.length);
    }, 3000);
    return () => clearInterval(id);
  }, [loadingPlayers, firstBuild]);

  const label = overrideLabel ?? (loadingPlayers
    ? "Loading players..."
    : firstBuild
      ? "Building maps for the first time..."
      : LOADING_STEPS[stepIndex]);

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

function FilterGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex w-full min-w-0 flex-col gap-1 sm:w-auto sm:flex-row sm:items-center sm:gap-1.5">
      <span className="text-[9px] uppercase tracking-wider text-osu-f1 font-semibold shrink-0">{label}</span>
      <div className="flex min-w-0 flex-wrap gap-0.5">{children}</div>
    </div>
  );
}

function SortPill({
  active,
  dir,
  onClick,
  children,
}: {
  active: boolean;
  dir: SortDirection;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`px-2 py-1 rounded text-[10px] font-medium transition-colors cursor-pointer inline-flex items-center gap-1 ${
        active
          ? "bg-osu-pink/20 text-osu-pink-light"
          : "bg-osu-b4 text-osu-f1 hover:text-osu-l2 hover:bg-osu-b3"
      }`}
      aria-pressed={active}
      title={active ? (dir === "desc" ? "Click to sort ascending" : "Click to sort descending") : undefined}
    >
      <span>{children}</span>
      {active && (
        <span aria-hidden className="text-[9px] leading-none opacity-90">
          {dir === "desc" ? "↓" : "↑"}
        </span>
      )}
    </button>
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
  onContextMenu,
  children,
}: {
  mode: TriStateMode | undefined;
  hasAnyActive: boolean;
  onClick: () => void;
  onContextMenu: () => void;
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
      onContextMenu={(event) => {
        event.preventDefault();
        onContextMenu();
      }}
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
    document.body.style.overflow = "hidden";
    if (scrollbarWidth > 0) {
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
            className="modal-card-mobile-safe relative isolate z-10 w-full max-w-[640px] max-h-[calc(100vh-1.5rem)] sm:max-h-[calc(100vh-3rem)] overflow-hidden rounded-2xl bg-osu-b5 ring-1 ring-white/10 shadow-2xl flex flex-col"
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

const OSU_DIRECT_SVG_PATHS = (
  <>
    <path d="m75.1 181.4c-4.7 0-8.8-0.8-12.3-2.3s-6.4-3.7-8.6-6.4c-2.3-2.7-4-5.9-5.2-9.6s-1.7-7.6-1.7-11.9 0.6-8.3 1.7-12c1.2-3.7 2.9-7 5.2-9.7s5.2-4.9 8.6-6.5 7.6-2.4 12.3-2.4 8.8 0.8 12.3 2.4 6.4 3.7 8.8 6.5c2.3 2.7 4 6 5.2 9.7 1.1 3.7 1.7 7.7 1.7 12s-0.6 8.2-1.7 11.9-2.8 6.9-5.2 9.6c-2.3 2.7-5.2 4.9-8.8 6.4-3.4 1.6-7.6 2.3-12.3 2.3zm0-12.1c4.2 0 7.2-1.6 9-4.7s2.7-7.6 2.7-13.4-0.9-10.3-2.7-13.4-4.8-4.7-9-4.7c-4.1 0-7.1 1.6-8.9 4.7s-2.7 7.6-2.7 13.4 0.9 10.3 2.7 13.4c1.8 3.2 4.8 4.7 8.9 4.7zm51.8-14.5c-4.2-1.2-7.5-3-9.8-5.3-2.4-2.4-3.5-5.9-3.5-10.6 0-5.7 2-10.1 6.1-13.4 4.1-3.2 9.6-4.8 16.7-4.8 2.9 0 5.8 0.3 8.6 0.8s5.7 1.3 8.6 2.4c-0.2 1.9-0.5 4-1.1 6.1s-1.3 3.9-2.1 5.5c-1.8-0.7-3.8-1.4-5.9-2-2.2-0.6-4.5-0.8-6.8-0.8-2.5 0-4.5 0.4-5.9 1.2s-2.1 2-2.1 3.8c0 1.6 0.5 2.8 1.5 3.5s2.4 1.3 4.3 1.9l6.4 1.9c2.1 0.6 4 1.3 5.7 2.2s3.1 1.9 4.3 3.2 2.1 2.8 2.8 4.7 1 4.2 1 6.8c0 2.8-0.6 5.3-1.7 7.7-1.2 2.4-2.8 4.5-5 6.2-2.2 1.8-4.9 3.1-8 4.2-3.1 1-6.7 1.5-10.7 1.5-1.8 0-3.4-0.1-4.9-0.2s-2.9-0.3-4.3-0.6-2.7-0.6-4.1-1c-1.3-0.4-2.8-0.9-4.4-1.5 0.1-2 0.5-4.1 1.1-6.1 0.6-2.1 1.3-4.1 2.2-6 2.5 1 4.8 1.7 7 2.2s4.5 0.7 6.9 0.7c1 0 2.2-0.1 3.4-0.3s2.4-0.5 3.4-1 1.9-1.1 2.6-1.9 1.1-1.8 1.1-3.1c0-1.8-0.5-3.1-1.6-3.9s-2.6-1.5-4.5-2.1zm39.3-32.7c2.7-0.4 5.3-0.7 8-0.7 2.6 0 5.3 0.2 8 0.7v30.7c0 3.1 0.2 5.6 0.7 7.6s1.2 3.6 2.2 4.7c1 1.2 2.3 2 3.8 2.5s3.3 0.7 5.3 0.7c2.8 0 5.1-0.3 7-0.8v-45.4c2.7-0.4 5.3-0.7 7.9-0.7s5.3 0.2 8 0.7v55.8c-2.4 0.8-5.6 1.6-9.5 2.4s-8 1.2-12.3 1.2c-3.8 0-7.5-0.3-11-0.9s-6.6-1.9-9.3-3.8-4.8-4.8-6.3-8.5c-1.6-3.7-2.4-8.7-2.4-14.9v-31.3zm65.9 58c-0.4-2.8-0.7-5.5-0.7-8.2s0.2-5.5 0.7-8.3c2.8-0.4 5.5-0.7 8.2-0.7s5.5 0.2 8.3 0.7c0.4 2.8 0.7 5.6 0.7 8.2 0 2.8-0.2 5.5-0.7 8.3-2.8 0.4-5.6 0.7-8.2 0.7-2.8-0.1-5.5-0.3-8.3-0.7zm-0.4-80.7c2.9-0.4 5.8-0.7 8.6-0.7 2.9 0 5.8 0.2 8.8 0.7l-1.1 54.9c-2.6 0.4-5.1 0.7-7.5 0.7-2.5 0-5.1-0.2-7.6-0.7z" />
    <path d="m150 0c-82.8 0-150 67.2-150 150s67.2 150 150 150 150-67.2 150-150-67.2-150-150-150zm0 285c-74.6 0-135-60.4-135-135s60.4-135 135-135 135 60.4 135 135-60.4 135-135 135z" />
  </>
);

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
  const dominantMod =
    details.kind === "farmed" ? getDominantSpeedMod(details.map.players) : null;
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
              <span className="inline-flex items-center px-2 py-1 rounded-full bg-black/55 ring-1 ring-white/15 text-[10px] font-bold text-white">
                {keyCount}K
              </span>
            )}
            {stars !== null && (
              <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-black/55 ring-1 ring-white/15 text-[10px] font-bold text-osu-yellow">
                <span>★</span>{stars.toFixed(2)}
              </span>
            )}
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
              <span
                className="h-3 w-3"
                style={{
                  backgroundColor: dominantModColor,
                  maskImage: `url(/images/badges/mods/mod-${dominantModFile}.svg)`,
                  WebkitMaskImage: `url(/images/badges/mods/mod-${dominantModFile}.svg)`,
                  maskSize: "120%",
                  WebkitMaskSize: "120%",
                  maskPosition: "center",
                  WebkitMaskPosition: "center",
                  maskRepeat: "no-repeat",
                  WebkitMaskRepeat: "no-repeat",
                }}
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
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-osu-b3/70 hover:bg-osu-b3 text-white/85 hover:text-white text-[12px] font-semibold transition-colors cursor-pointer"
          title="Open in osu! client"
        >
          <svg viewBox="0 0 300 300" className="h-[14px] w-[14px]" fill="currentColor" aria-hidden>
            {OSU_DIRECT_SVG_PATHS}
          </svg>
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
  meta,
  onClick,
}: {
  rank?: number;
  player: { id: number; username: string; avatarUrl: string };
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
      <div className="text-[12px] text-osu-l2 group-hover:text-white truncate flex-1 transition-colors">{player.username}</div>
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

// Loads a map's player list one page (50) at a time from the live backend,
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
  const dominantMod = getDominantSpeedMod(map.players);
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
          <span className="absolute top-1.5 left-1.5 px-1.5 py-0.5 rounded bg-black/60 text-[9px] font-bold text-white">{kc}K</span>
        )}
        <span className="absolute top-1.5 right-1.5 px-1.5 py-0.5 rounded bg-black/60 text-[9px] font-bold text-osu-yellow">
          {"\u2605"}{map.difficultyRating.toFixed(2)}
        </span>
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

        <PlayerAvatars players={fav.players} onPlayerClick={(player) => onPlayerClick(player.username)} />
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
  const maniaBeatmaps = useMemo(
    () => [...(bm.maniaBeatmaps ?? [])].sort((a, b) => b.difficultyRating - a.difficultyRating),
    [bm.maniaBeatmaps],
  );
  const usesSetPreviewForReplayAudio = useMemo(
    () => shouldUseSetPreviewForReplayAudio(maniaBeatmaps),
    [maniaBeatmaps],
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
    ? previewUrl
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
  // failure so we can swap in a deterministic gradient fallback.
  const [coverBroken, setCoverBroken] = useState(false);
  const [coverLoaded, setCoverLoaded] = useState(false);
  useEffect(() => {
    previewPlaybackTokenRef.current += 1;
    replayPlaybackTokenRef.current += 1;
    resetAudioElement(audioRef.current);
    resetAudioElement(replayAudioRef.current);
    setCoverBroken(false);
    setCoverLoaded(false);
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
          setReplayAudioMode(
            previewPlan.audioMode === "set-preview" && !timedRateVariant && previewPlan.beatmap.audioFilename
              ? "selected-file"
              : previewPlan.audioMode,
          );
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
  }, [maniaBeatmaps, metadataBeatmapsetId, replayChartScrub, replayPreviewRequested, selectedBeatmap, selectedDifficultyRate, usesSetPreviewForReplayAudio]);

  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = volume;
    if (replayAudioRef.current) replayAudioRef.current.volume = volume;
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
  }, [currentTime, duration, isPreviewPlaying, previewUrl, resetReplayPreview]);

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
    void audio.play()
      .then(() => {
        if (replayAudioRef.current !== audio || requestedAudioModeRef.current !== "replay") return;
        setIsReplayPreviewPlaying(true);
      })
      .catch(() => {
        replayAudioClockAnchorRef.current = null;
      });
  }, [getReplayChartPlaybackMs, isReplayPreviewPlaying, replayAudioPlaybackRate]);

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
  }, [clearReplayPreviewEndTimer, isReplayPreviewReady, pausePreviewAudio, previewBeatmap, replayAudioMode, replayAudioPlaybackRate, replayChartStartMs, replayPreviewStartSeconds, startReplayPreviewAudio]);

  useEffect(() => {
    if (replayPreviewRequested && previewBeatmap && isReplayPreviewReady && !replayPreviewLoading && replayAudioStartPendingRef.current) {
      void startReplayPreviewAudio(replayPlaybackTokenRef.current);
    }
  }, [isReplayPreviewReady, previewBeatmap, replayPreviewLoading, replayPreviewRequested, startReplayPreviewAudio]);

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

  const displayDuration = duration > 0 ? Math.min(duration, RANDOM_REPLAY_PREVIEW_MS / 1000) : 0;
  const progressRatio = displayDuration > 0 ? Math.min(1, currentTime / displayDuration) : 0;
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
        <BeatmapStatusBadge status={bm.status} className="absolute top-3 left-3" />
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
              <svg viewBox="0 0 300 300" className="h-[26px] w-[26px]" fill="currentColor">
                <path d="m75.1 181.4c-4.7 0-8.8-0.8-12.3-2.3s-6.4-3.7-8.6-6.4c-2.3-2.7-4-5.9-5.2-9.6s-1.7-7.6-1.7-11.9 0.6-8.3 1.7-12c1.2-3.7 2.9-7 5.2-9.7s5.2-4.9 8.6-6.5 7.6-2.4 12.3-2.4 8.8 0.8 12.3 2.4 6.4 3.7 8.8 6.5c2.3 2.7 4 6 5.2 9.7 1.1 3.7 1.7 7.7 1.7 12s-0.6 8.2-1.7 11.9-2.8 6.9-5.2 9.6c-2.3 2.7-5.2 4.9-8.8 6.4-3.4 1.6-7.6 2.3-12.3 2.3zm0-12.1c4.2 0 7.2-1.6 9-4.7s2.7-7.6 2.7-13.4-0.9-10.3-2.7-13.4-4.8-4.7-9-4.7c-4.1 0-7.1 1.6-8.9 4.7s-2.7 7.6-2.7 13.4 0.9 10.3 2.7 13.4c1.8 3.2 4.8 4.7 8.9 4.7zm51.8-14.5c-4.2-1.2-7.5-3-9.8-5.3-2.4-2.4-3.5-5.9-3.5-10.6 0-5.7 2-10.1 6.1-13.4 4.1-3.2 9.6-4.8 16.7-4.8 2.9 0 5.8 0.3 8.6 0.8s5.7 1.3 8.6 2.4c-0.2 1.9-0.5 4-1.1 6.1s-1.3 3.9-2.1 5.5c-1.8-0.7-3.8-1.4-5.9-2-2.2-0.6-4.5-0.8-6.8-0.8-2.5 0-4.5 0.4-5.9 1.2s-2.1 2-2.1 3.8c0 1.6 0.5 2.8 1.5 3.5s2.4 1.3 4.3 1.9l6.4 1.9c2.1 0.6 4 1.3 5.7 2.2s3.1 1.9 4.3 3.2 2.1 2.8 2.8 4.7 1 4.2 1 6.8c0 2.8-0.6 5.3-1.7 7.7-1.2 2.4-2.8 4.5-5 6.2-2.2 1.8-4.9 3.1-8 4.2-3.1 1-6.7 1.5-10.7 1.5-1.8 0-3.4-0.1-4.9-0.2s-2.9-0.3-4.3-0.6-2.7-0.6-4.1-1c-1.3-0.4-2.8-0.9-4.4-1.5 0.1-2 0.5-4.1 1.1-6.1 0.6-2.1 1.3-4.1 2.2-6 2.5 1 4.8 1.7 7 2.2s4.5 0.7 6.9 0.7c1 0 2.2-0.1 3.4-0.3s2.4-0.5 3.4-1 1.9-1.1 2.6-1.9 1.1-1.8 1.1-3.1c0-1.8-0.5-3.1-1.6-3.9s-2.6-1.5-4.5-2.1zm39.3-32.7c2.7-0.4 5.3-0.7 8-0.7 2.6 0 5.3 0.2 8 0.7v30.7c0 3.1 0.2 5.6 0.7 7.6s1.2 3.6 2.2 4.7c1 1.2 2.3 2 3.8 2.5s3.3 0.7 5.3 0.7c2.8 0 5.1-0.3 7-0.8v-45.4c2.7-0.4 5.3-0.7 7.9-0.7s5.3 0.2 8 0.7v55.8c-2.4 0.8-5.6 1.6-9.5 2.4s-8 1.2-12.3 1.2c-3.8 0-7.5-0.3-11-0.9s-6.6-1.9-9.3-3.8-4.8-4.8-6.3-8.5c-1.6-3.7-2.4-8.7-2.4-14.9v-31.3zm65.9 58c-0.4-2.8-0.7-5.5-0.7-8.2s0.2-5.5 0.7-8.3c2.8-0.4 5.5-0.7 8.2-0.7s5.5 0.2 8.3 0.7c0.4 2.8 0.7 5.6 0.7 8.2 0 2.8-0.2 5.5-0.7 8.3-2.8 0.4-5.6 0.7-8.2 0.7-2.8-0.1-5.5-0.3-8.3-0.7zm-0.4-80.7c2.9-0.4 5.8-0.7 8.6-0.7 2.9 0 5.8 0.2 8.8 0.7l-1.1 54.9c-2.6 0.4-5.1 0.7-7.5 0.7-2.5 0-5.1-0.2-7.6-0.7z" />
                <path d="m150 0c-82.8 0-150 67.2-150 150s67.2 150 150 150 150-67.2 150-150-67.2-150-150-150zm0 285c-74.6 0-135-60.4-135-135s60.4-135 135-135 135 60.4 135 135-60.4 135-135 135z" />
              </svg>
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

        {maniaBeatmaps.length > 1 && (
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
                <div
                  className="absolute inset-y-0 left-0 bg-osu-pink rounded-full"
                  style={{ width: `${progressRatio * 100}%` }}
                />
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
              ref={audioRef}
              src={previewUrl}
              preload="metadata"
              onLoadedMetadata={(e) => setDuration(e.currentTarget.duration || 0)}
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
                setPreviewError("Couldn't load preview");
                setIsPreviewPlaying(false);
              }}
            />
            {replayAudioUrl ? (
              <audio
                ref={replayAudioRef}
                src={replayAudioUrl}
                preload={replayAudioMode === "set-preview" ? "metadata" : "none"}
                onCanPlay={() => setReplayAudioLoading(false)}
                onPlaying={() => setReplayAudioLoading(false)}
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
        {replayPreviewError ? (
          <div className="absolute inset-x-3 top-3 rounded-md bg-black/60 px-2 py-1 text-[10px] text-rose-300">
            {replayPreviewError}
          </div>
        ) : null}
      </div>
    </div>
  );
}
