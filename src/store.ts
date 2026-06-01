import { useContext, useMemo, useSyncExternalStore } from "react";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { getAvatarAccentStoreKey } from "./lib/avatar-accent";
import { DEFAULT_INITIAL_SCOPE, normalizeCountryScope } from "./lib/country";
import { InitialCountryContext } from "./lib/country-context";
import { readAutoCountryCookieClient, readCountryCookieClient, writeCountryCookieClient } from "./lib/country-cookie";
import { getScoreIdentity, getScoreTimeMs } from "./lib/score";
import type {
  OsuScore,
  RankingsResponse,
  CountryMapsData,
  LeanHomeScore,
  LeanHomePopoff,
  LeanTrackerScore,
  SnipeEvent,
} from "./lib/types";

export interface CachedAvatarAccent {
  fetchedAt: number;
  value: string | null;
}

export interface CachedScoreGain {
  fetchedAt: number;
  value: number;
}

export const AVATAR_ACCENT_CLIENT_TTL = 24 * 60 * 60 * 1000;
export const AVATAR_ACCENT_FAILURE_TTL = 5 * 60 * 1000;
export const TRACKER_PP_GAIN_CLIENT_TTL = 10 * 60 * 1000;
export const TRACKER_FEED_SCORE_LIMIT = 500;
// The in-memory feed holds up to TRACKER_FEED_SCORE_LIMIT, but only this many
// (newest-first) are persisted per country. 500 scores/country bloated the
// localStorage blob past the ~5MB quota, so live-feed writes silently failed
// and the cached feed froze at the last set that fit (you'd see the same stale
// scores on every reload). A small slice still gives an instant first paint;
// the live snapshot backfills the rest within ~1s.
export const TRACKER_FEED_PERSIST_LIMIT = 60;
export const TOP_PLAYS_RANGE_STORAGE_KEY = "mania-hub-top-plays-range-v1";
export const SNIPES_FILTERS_STORAGE_KEY = "mania-hub-snipes-filters-v1";
export const DEFAULT_THEME_HUE = 333;
// Persisted separately from the main `mania-hub-cache-v5` blob. Mobile Safari's
// localStorage quota is tight (~5MB) and our cache payload can approach it; a
// QuotaExceededError on the big blob would silently drop the theme change, so
// the theme lives in its own tiny key that survives even when the main blob
// write fails. Keep this key in sync with the inline bootstrap script in
// `src/routes/__root.tsx` that applies the hue before React hydrates.
export const THEME_HUE_STORAGE_KEY = "mania-hub-theme-v1";
export const THEME_SAT_STORAGE_KEY = "mania-hub-theme-sat-v1";
export const DEFAULT_THEME_SAT = 100;
// Same defensive split as the theme key, plus: writes to the main blob are
// debounced 250ms and only flushed on `pagehide`/`visibilitychange`. Mobile
// browsers don't reliably fire those on fast reload, so accent writes that
// landed within the last 250ms before reload were getting dropped. With nothing
// in storage on reload the username re-faded from white every time. This key
// writes synchronously and bypasses the debounce entirely.
export const AVATAR_ACCENTS_STORAGE_KEY = "mania-hub-avatar-accents-v1";
// Hidden players: a personal, per-browser list of users whose scores are
// filtered out of every surface. Lives in its own key (not the main blob) so
// it can be seeded synchronously before persist hydrates — rankings is
// server-rendered, so without an early seed a hidden player would flash in
// and then vanish on the hydration re-render.
export const HIDDEN_USERS_STORAGE_KEY = "mania-hub-hidden-users-v1";
// Keep the list bounded so it can never grow the localStorage payload in a way
// that matters; well above any realistic personal hide list.
export const HIDDEN_USERS_LIMIT = 200;

function applyThemeHueToDom(hue: number): void {
  if (typeof document === "undefined") return;
  document.documentElement.style.setProperty("--theme-hue", String(hue));
  if (hue === DEFAULT_THEME_HUE) {
    document.documentElement.style.removeProperty("--theme-hue-mix");
  } else {
    document.documentElement.style.setProperty("--theme-hue-mix", "1");
  }
}

function applyThemeSatToDom(sat: number): void {
  if (typeof document === "undefined") return;
  document.documentElement.style.setProperty("--theme-sat", String(sat / 100));
}

function clampThemeSat(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return DEFAULT_THEME_SAT;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function readThemeSatFromStorage(): number | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(THEME_SAT_STORAGE_KEY);
    if (raw == null) return null;
    const n = Number(raw);
    if (!Number.isFinite(n)) return null;
    return clampThemeSat(n);
  } catch {
    return null;
  }
}

function writeThemeSatToStorage(sat: number): void {
  if (typeof window === "undefined") return;
  try {
    if (sat === DEFAULT_THEME_SAT) {
      localStorage.removeItem(THEME_SAT_STORAGE_KEY);
    } else {
      localStorage.setItem(THEME_SAT_STORAGE_KEY, String(sat));
    }
  } catch (error) {
    warnStorageIssue(`write "${THEME_SAT_STORAGE_KEY}"`, error);
  }
}

function clampThemeHue(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return DEFAULT_THEME_HUE;
  const rounded = Math.round(n);
  return ((rounded % 360) + 360) % 360;
}

function readThemeHueFromStorage(): number | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(THEME_HUE_STORAGE_KEY);
    if (raw == null) return null;
    const n = Number(raw);
    if (!Number.isFinite(n)) return null;
    return clampThemeHue(n);
  } catch (error) {
    warnStorageIssue(`read "${THEME_HUE_STORAGE_KEY}"`, error);
    return null;
  }
}

function writeThemeHueToStorage(hue: number): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(THEME_HUE_STORAGE_KEY, String(hue));
  } catch (error) {
    warnStorageIssue(`write "${THEME_HUE_STORAGE_KEY}"`, error);
  }
}

function removeThemeHueFromStorage(): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(THEME_HUE_STORAGE_KEY);
  } catch (error) {
    warnStorageIssue(`remove "${THEME_HUE_STORAGE_KEY}"`, error);
  }
}

function filterFreshAvatarAccents(raw: unknown): Record<string, CachedAvatarAccent> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const result: Record<string, CachedAvatarAccent> = {};
  const now = Date.now();
  for (const [key, entry] of Object.entries(raw)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const fetchedAt = (entry as CachedAvatarAccent).fetchedAt;
    const value = (entry as CachedAvatarAccent).value;
    if (!Number.isFinite(fetchedAt)) continue;
    const ttl = value === null ? AVATAR_ACCENT_FAILURE_TTL : AVATAR_ACCENT_CLIENT_TTL;
    if (now - fetchedAt >= ttl) continue;
    if (value !== null && typeof value !== "string") continue;
    result[key] = { value, fetchedAt };
  }
  return result;
}

function readAvatarAccentsFromStorage(): Record<string, CachedAvatarAccent> {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(AVATAR_ACCENTS_STORAGE_KEY);
    if (!raw) return {};
    return filterFreshAvatarAccents(JSON.parse(raw));
  } catch (error) {
    warnStorageIssue(`read "${AVATAR_ACCENTS_STORAGE_KEY}"`, error);
    return {};
  }
}

function writeAvatarAccentsToStorage(accents: Record<string, CachedAvatarAccent>): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(AVATAR_ACCENTS_STORAGE_KEY, JSON.stringify(accents));
  } catch (error) {
    warnStorageIssue(`write "${AVATAR_ACCENTS_STORAGE_KEY}"`, error);
  }
}

export interface CachedPlayer {
  id: number;
  username: string;
  avatar_url: string;
}

export interface HiddenUser {
  id: number;
  username: string;
  avatarUrl: string;
  countryCode: string;
}

function isHiddenUser(value: unknown): value is HiddenUser {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const user = value as Record<string, unknown>;
  return (
    typeof user.id === "number" &&
    Number.isFinite(user.id) &&
    typeof user.username === "string" &&
    typeof user.avatarUrl === "string" &&
    typeof user.countryCode === "string"
  );
}

function readHiddenUsersFromStorage(): Record<number, HiddenUser> {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(HIDDEN_USERS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const result: Record<number, HiddenUser> = {};
    for (const entry of Object.values(parsed)) {
      if (!isHiddenUser(entry)) continue;
      result[entry.id] = entry;
    }
    return result;
  } catch (error) {
    warnStorageIssue(`read "${HIDDEN_USERS_STORAGE_KEY}"`, error);
    return {};
  }
}

function writeHiddenUsersToStorage(users: Record<number, HiddenUser>): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(HIDDEN_USERS_STORAGE_KEY, JSON.stringify(users));
  } catch (error) {
    warnStorageIssue(`write "${HIDDEN_USERS_STORAGE_KEY}"`, error);
  }
}

export interface CachedPopoff {
  user: CachedPlayer;
  score: OsuScore;
  pp: number;
  weightedPP: number;
  ppGain: number;
  time: string;
}

export type TopPlaysRange = "24h" | "3d" | "7d" | "30d";
export type SnipesRange = "24h" | "7d" | "30d";
export type SnipesKeyFilter = "all" | "4k" | "7k";

export interface SnipesFilters {
  keys: SnipesKeyFilter;
  range: SnipesRange;
}

export const DEFAULT_SNIPES_FILTERS: SnipesFilters = {
  keys: "all",
  range: "7d",
};

type CountryRecord<T> = Record<string, T>;

interface AppState {
  selectedCountry: string;
  themeHue: number;
  themeSaturation: number;
  showDanEstimates: boolean;
  hiddenUsers: Record<number, HiddenUser>;
  avatarAccents: Record<string, CachedAvatarAccent>;
  rankingsByCountry: CountryRecord<RankingsResponse>;
  rankingsFetchedAtByCountry: CountryRecord<number>;
  rankHistories: Record<number, number[]>;
  rankHistoriesFetchedAt: Record<number, number>;
  homeRecentScoresByCountry: CountryRecord<LeanHomeScore[]>;
  homeRecentScoresFetchedAtByCountry: CountryRecord<number>;
  homePopoffsByCountry: CountryRecord<LeanHomePopoff[]>;
  homePopoffsFetchedAtByCountry: CountryRecord<number>;
  topPlaysRangeByCountry: CountryRecord<TopPlaysRange>;
  snipesFiltersByCountry: CountryRecord<SnipesFilters>;
  popoffsByCountry: CountryRecord<CachedPopoff[]>;
  popoffsFetchedAtByCountry: CountryRecord<number>;
  popoffsWindowByCountry: CountryRecord<TopPlaysRange>;
  mapsDataByCountry: CountryRecord<CountryMapsData>;
  mapsDataFetchedAtByCountry: CountryRecord<number>;
  feedScoresByCountry: CountryRecord<LeanTrackerScore[]>;
  feedScoresFetchedAtByCountry: CountryRecord<number>;
  trackerPpGainsByCountry: CountryRecord<Record<number, CachedScoreGain>>;
  snipesByCountry: CountryRecord<SnipeEvent[]>;
  snipesFetchedAtByCountry: CountryRecord<number>;
  trackedUserIdsByCountry: CountryRecord<number[]>;
  trackedUserIdsFetchedAtByCountry: CountryRecord<number>;
  pollIndexByCountry: CountryRecord<number>;
  setSelectedCountry: (country: string) => void;
  setThemeHue: (hue: number) => void;
  setThemeSaturation: (sat: number) => void;
  setShowDanEstimates: (show: boolean) => void;
  addHiddenUser: (user: HiddenUser) => void;
  removeHiddenUser: (userId: number) => void;
  resetThemeHue: () => void;
  setAvatarAccents: (accents: Record<string, string | null>, fetchedAt?: number) => void;
  setRankings: (country: string, rankings: RankingsResponse) => void;
  setRankHistories: (histories: Record<number, number[]>) => void;
  setHomeRecentScores: (country: string, scores: LeanHomeScore[]) => void;
  setHomePopoffs: (country: string, popoffs: LeanHomePopoff[]) => void;
  setTopPlaysRange: (country: string, range: TopPlaysRange) => void;
  setSnipesFilters: (country: string, filters: SnipesFilters) => void;
  setPopoffs: (country: string, popoffs: CachedPopoff[], window: TopPlaysRange) => void;
  setMapsData: (country: string, data: CountryMapsData) => void;
  setSnipes: (country: string, events: SnipeEvent[], scannedAt: number) => void;
  addFeedScores: (country: string, scores: LeanTrackerScore[]) => void;
  markFeedScoresFetched: (country: string) => void;
  setTrackerPpGains: (country: string, gains: Record<number, number>, fetchedAt?: number) => void;
  setTrackedUserIds: (country: string, ids: number[]) => void;
  nextPollIndex: (country: string) => void;
  resetPollIndex: (country: string) => void;
}

const warnedStorageIssues = new Set<string>();

function warnStorageIssue(action: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  const warningKey = `${action}:${message}`;
  if (warnedStorageIssues.has(warningKey)) return;
  warnedStorageIssues.add(warningKey);
  console.warn(`[store] ${action} failed: ${message}`);
}

// localStorage quota errors surface under a few names/codes across browsers
// (Chrome/Edge "QuotaExceededError" code 22, Firefox "NS_ERROR_DOM_QUOTA_REACHED"
// code 1014). Older WebKit also threw plain code 22.
function isQuotaExceededError(error: unknown): boolean {
  if (!(error instanceof DOMException)) return false;
  return (
    error.name === "QuotaExceededError" ||
    error.name === "NS_ERROR_DOM_QUOTA_REACHED" ||
    error.code === 22 ||
    error.code === 1014
  );
}

function readTopPlaysRangeByCountry(): CountryRecord<TopPlaysRange> {
  if (typeof window === "undefined") return {};

  try {
    const raw = localStorage.getItem(TOP_PLAYS_RANGE_STORAGE_KEY);
    if (!raw) return {};

    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};

    return Object.fromEntries(
      Object.entries(parsed).filter(([, range]) =>
        range === "24h" || range === "3d" || range === "7d" || range === "30d",
      ),
    ) as CountryRecord<TopPlaysRange>;
  } catch (error) {
    warnStorageIssue(`read "${TOP_PLAYS_RANGE_STORAGE_KEY}"`, error);
    return {};
  }
}

function writeTopPlaysRangeByCountry(ranges: CountryRecord<TopPlaysRange>): void {
  if (typeof window === "undefined") return;

  try {
    localStorage.setItem(TOP_PLAYS_RANGE_STORAGE_KEY, JSON.stringify(ranges));
  } catch (error) {
    warnStorageIssue(`write "${TOP_PLAYS_RANGE_STORAGE_KEY}"`, error);
  }
}

function isSnipesRange(value: unknown): value is SnipesRange {
  return value === "24h" || value === "7d" || value === "30d";
}

function isSnipesKeyFilter(value: unknown): value is SnipesKeyFilter {
  return value === "all" || value === "4k" || value === "7k";
}

function readSnipesFiltersByCountry(): CountryRecord<SnipesFilters> {
  if (typeof window === "undefined") return {};

  try {
    const raw = localStorage.getItem(SNIPES_FILTERS_STORAGE_KEY);
    if (!raw) return {};

    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};

    const result: CountryRecord<SnipesFilters> = {};
    for (const [country, filters] of Object.entries(parsed)) {
      if (!filters || typeof filters !== "object" || Array.isArray(filters)) continue;
      const candidate = filters as Partial<SnipesFilters>;
      if (!isSnipesRange(candidate.range) || !isSnipesKeyFilter(candidate.keys)) continue;
      result[normalizeCountryScope(country)] = {
        range: candidate.range,
        keys: candidate.keys,
      };
    }
    return result;
  } catch (error) {
    warnStorageIssue(`read "${SNIPES_FILTERS_STORAGE_KEY}"`, error);
    return {};
  }
}

function writeSnipesFiltersByCountry(filters: CountryRecord<SnipesFilters>): void {
  if (typeof window === "undefined") return;

  try {
    localStorage.setItem(SNIPES_FILTERS_STORAGE_KEY, JSON.stringify(filters));
  } catch (error) {
    warnStorageIssue(`write "${SNIPES_FILTERS_STORAGE_KEY}"`, error);
  }
}

// Zustand's persist middleware calls storage.setItem on every state change,
// and each call synchronously writes the full partialized blob via
// localStorage.setItem — ~20-50ms for our ~100KB payload. A single navigation
// triggers several state updates in rapid succession (router match, mount
// effects, fetch .then callbacks, polling intervals), which stacked up to
// ~200ms of main-thread blocking during the click -> paint window.
//
// This wrapper coalesces setItem calls within a short window into one write
// and dispatches them via setTimeout(0) so the actual localStorage.setItem
// runs on a later task, after the current render has painted. If the tab is
// closing we flush synchronously via pagehide so nothing is lost.
const PERSIST_DEBOUNCE_MS = 250;
const storage = typeof window !== "undefined"
  ? createJSONStorage(() => {
      const pending = new Map<string, string | null>();
      let timer: ReturnType<typeof setTimeout> | null = null;

      const flush = () => {
        if (timer != null) {
          clearTimeout(timer);
          timer = null;
        }
        if (pending.size === 0) return;
        const batch = Array.from(pending.entries());
        pending.clear();
        for (const [name, value] of batch) {
          try {
            if (value === null) {
              localStorage.removeItem(name);
            } else {
              localStorage.setItem(name, value);
            }
          } catch (error) {
            if (isQuotaExceededError(error) && value !== null) {
              // Over quota. Drop the stale value first so we never keep serving
              // a frozen cache, then retry — the freed space usually fits the
              // new (now-smaller) blob. If even that fails, the key stays evicted
              // and the next load starts fresh instead of stuck on old data.
              try {
                localStorage.removeItem(name);
                localStorage.setItem(name, value);
              } catch (retryError) {
                warnStorageIssue(`write "${name}" (evicted, still over quota)`, retryError);
              }
            } else {
              warnStorageIssue(`write "${name}"`, error);
            }
          }
        }
      };
      const schedule = () => {
        if (timer != null) return;
        timer = setTimeout(flush, PERSIST_DEBOUNCE_MS);
      };

      // Best-effort sync flush on tab hide/unload so we don't lose the last
      // batch if the user closes the page within the debounce window.
      window.addEventListener("pagehide", flush);
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") flush();
      });

      return {
        getItem: (name) => {
          // Honor pending writes so consecutive read-after-write stays coherent.
          if (pending.has(name)) {
            return pending.get(name) ?? null;
          }
          try {
            return localStorage.getItem(name);
          } catch (error) {
            warnStorageIssue(`read "${name}"`, error);
            return null;
          }
        },
        setItem: (name, value) => {
          pending.set(name, value);
          schedule();
        },
        removeItem: (name) => {
          pending.set(name, null);
          schedule();
        },
      };
    })
  : undefined;

// On the client, prefer the cookie value as the initial selectedCountry so
// that the store agrees with what the server rendered. localStorage may be
// stale (e.g. user cleared the cookie) — the cookie wins because it's what
// drove the SSR HTML the user just saw.
const initialClientCountry = readCountryCookieClient();
// Pulled from the dedicated key so the store starts with the right hue even
// before persist hydration runs its async merge. Mirrors the inline bootstrap
// script so client rendering stays consistent from the first paint.
const initialClientThemeHue = readThemeHueFromStorage();
const initialClientThemeSat = readThemeSatFromStorage();
// Same idea for accents: seed the store before persist hydrates so the very
// first React render after JS executes already has colors. Without this, the
// initial render uses an empty map and the username flashes white before the
// hydration re-render swaps in the persisted accents.
const initialClientAvatarAccents = readAvatarAccentsFromStorage();
// Same idea: seed the hidden-players list before persist hydrates so the very
// first render — including server-rendered surfaces like rankings — already
// filters them out instead of flashing them in.
const initialClientHiddenUsers = readHiddenUsersFromStorage();

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
      selectedCountry: initialClientCountry ?? DEFAULT_INITIAL_SCOPE,
      themeHue: initialClientThemeHue ?? DEFAULT_THEME_HUE,
      themeSaturation: initialClientThemeSat ?? DEFAULT_THEME_SAT,
      showDanEstimates: false,
      hiddenUsers: initialClientHiddenUsers,
      avatarAccents: initialClientAvatarAccents,
      rankingsByCountry: {},
      rankingsFetchedAtByCountry: {},
      rankHistories: {},
      rankHistoriesFetchedAt: {},
      homeRecentScoresByCountry: {},
      homeRecentScoresFetchedAtByCountry: {},
      homePopoffsByCountry: {},
      homePopoffsFetchedAtByCountry: {},
      topPlaysRangeByCountry: readTopPlaysRangeByCountry(),
      snipesFiltersByCountry: readSnipesFiltersByCountry(),
      popoffsByCountry: {},
      popoffsFetchedAtByCountry: {},
      popoffsWindowByCountry: {},
      mapsDataByCountry: {},
      mapsDataFetchedAtByCountry: {},
      feedScoresByCountry: {},
      feedScoresFetchedAtByCountry: {},
      trackerPpGainsByCountry: {},
      snipesByCountry: {},
      snipesFetchedAtByCountry: {},
      trackedUserIdsByCountry: {},
      trackedUserIdsFetchedAtByCountry: {},
      pollIndexByCountry: {},
      setSelectedCountry: (country) => {
        const normalized = normalizeCountryScope(country);
        writeCountryCookieClient(normalized);
        set({ selectedCountry: normalized });
      },
      setThemeHue: (hue) => {
        const clamped = clampThemeHue(hue);
        applyThemeHueToDom(clamped);
        writeThemeHueToStorage(clamped);
        set({ themeHue: clamped });
      },
      setThemeSaturation: (sat) => {
        const clamped = clampThemeSat(sat);
        applyThemeSatToDom(clamped);
        writeThemeSatToStorage(clamped);
        set({ themeSaturation: clamped });
      },
      setShowDanEstimates: (show) => set({ showDanEstimates: show }),
      addHiddenUser: (user) =>
        set((state) => {
          // Re-adding an existing entry refreshes its stored username/avatar
          // without counting against the limit.
          const alreadyHidden = user.id in state.hiddenUsers;
          if (!alreadyHidden && Object.keys(state.hiddenUsers).length >= HIDDEN_USERS_LIMIT) {
            return state;
          }
          const next = { ...state.hiddenUsers, [user.id]: user };
          writeHiddenUsersToStorage(next);
          return { hiddenUsers: next };
        }),
      removeHiddenUser: (userId) =>
        set((state) => {
          if (!(userId in state.hiddenUsers)) return state;
          const next = { ...state.hiddenUsers };
          delete next[userId];
          writeHiddenUsersToStorage(next);
          return { hiddenUsers: next };
        }),
      resetThemeHue: () => {
        applyThemeHueToDom(DEFAULT_THEME_HUE);
        removeThemeHueFromStorage();
        applyThemeSatToDom(DEFAULT_THEME_SAT);
        writeThemeSatToStorage(DEFAULT_THEME_SAT);
        set({ themeHue: DEFAULT_THEME_HUE, themeSaturation: DEFAULT_THEME_SAT });
      },
      setAvatarAccents: (accents, fetchedAt = Date.now()) =>
        set((state) => {
          const merged = {
            ...state.avatarAccents,
            ...Object.fromEntries(
              Object.entries(accents).map(([url, accent]) => [
                getAvatarAccentStoreKey(url),
                { value: accent, fetchedAt },
              ]),
            ),
          };
          writeAvatarAccentsToStorage(merged);
          return { avatarAccents: merged };
        }),
      setRankings: (country, rankings) =>
        set((state) => {
          const normalizedCountry = normalizeCountryScope(country);
          return {
            rankingsByCountry: {
              ...state.rankingsByCountry,
              [normalizedCountry]: rankings,
            },
            rankingsFetchedAtByCountry: {
              ...state.rankingsFetchedAtByCountry,
              [normalizedCountry]: Date.now(),
            },
          };
        }),
      setRankHistories: (histories) =>
        set((state) => {
          const fetchedAt = Date.now();
          return {
            rankHistories: { ...state.rankHistories, ...histories },
            rankHistoriesFetchedAt: {
              ...state.rankHistoriesFetchedAt,
              ...Object.fromEntries(
                Object.keys(histories).map((userId) => [Number(userId), fetchedAt]),
              ),
            },
          };
        }),
      setHomeRecentScores: (country, scores) =>
        set((state) => {
          const normalizedCountry = normalizeCountryScope(country);
          return {
            homeRecentScoresByCountry: {
              ...state.homeRecentScoresByCountry,
              [normalizedCountry]: scores,
            },
            homeRecentScoresFetchedAtByCountry: {
              ...state.homeRecentScoresFetchedAtByCountry,
              [normalizedCountry]: Date.now(),
            },
          };
        }),
      setHomePopoffs: (country, popoffs) =>
        set((state) => {
          const normalizedCountry = normalizeCountryScope(country);
          return {
            homePopoffsByCountry: {
              ...state.homePopoffsByCountry,
              [normalizedCountry]: popoffs,
            },
            homePopoffsFetchedAtByCountry: {
              ...state.homePopoffsFetchedAtByCountry,
              [normalizedCountry]: Date.now(),
            },
          };
        }),
      setTopPlaysRange: (country, range) =>
        set((state) => {
          const normalizedCountry = normalizeCountryScope(country);
          const nextTopPlaysRangeByCountry = {
            ...state.topPlaysRangeByCountry,
            [normalizedCountry]: range,
          };

          writeTopPlaysRangeByCountry(nextTopPlaysRangeByCountry);

          return {
            topPlaysRangeByCountry: nextTopPlaysRangeByCountry,
          };
        }),
      setSnipesFilters: (country, filters) =>
        set((state) => {
          const normalizedCountry = normalizeCountryScope(country);
          const previous = state.snipesFiltersByCountry[normalizedCountry];
          if (
            previous?.keys === filters.keys &&
            previous.range === filters.range
          ) {
            return state;
          }
          const nextSnipesFiltersByCountry = {
            ...state.snipesFiltersByCountry,
            [normalizedCountry]: filters,
          };

          writeSnipesFiltersByCountry(nextSnipesFiltersByCountry);

          return {
            snipesFiltersByCountry: nextSnipesFiltersByCountry,
          };
        }),
      setPopoffs: (country, popoffs, window) =>
        set((state) => {
          const normalizedCountry = normalizeCountryScope(country);
          return {
            popoffsByCountry: {
              ...state.popoffsByCountry,
              [normalizedCountry]: popoffs,
            },
            popoffsFetchedAtByCountry: {
              ...state.popoffsFetchedAtByCountry,
              [normalizedCountry]: Date.now(),
            },
            popoffsWindowByCountry: {
              ...state.popoffsWindowByCountry,
              [normalizedCountry]: window,
            },
          };
        }),
      setMapsData: (country, data) =>
        set((state) => {
          const normalizedCountry = normalizeCountryScope(country);
          return {
            mapsDataByCountry: {
              ...state.mapsDataByCountry,
              [normalizedCountry]: data,
            },
            mapsDataFetchedAtByCountry: {
              ...state.mapsDataFetchedAtByCountry,
              [normalizedCountry]: Date.now(),
            },
          };
        }),
      setSnipes: (country, events, scannedAt) =>
        set((state) => {
          const normalizedCountry = normalizeCountryScope(country);
          return {
            snipesByCountry: {
              ...state.snipesByCountry,
              [normalizedCountry]: events,
            },
            snipesFetchedAtByCountry: {
              ...state.snipesFetchedAtByCountry,
              [normalizedCountry]: scannedAt,
            },
          };
        }),
      addFeedScores: (country, scores) =>
        set((state) => {
          const normalizedCountry = normalizeCountryScope(country);
          const currentScores = state.feedScoresByCountry[normalizedCountry] ?? [];
          const seen = new Set<string>();
          const merged = [...scores, ...currentScores]
            .sort((a, b) => getScoreTimeMs(b) - getScoreTimeMs(a))
            .filter((score) => {
              const key = getScoreIdentity(score);
              if (seen.has(key)) return false;
              seen.add(key);
              return true;
            })
            .slice(0, TRACKER_FEED_SCORE_LIMIT);

          return {
            feedScoresByCountry: {
              ...state.feedScoresByCountry,
              [normalizedCountry]: merged,
            },
            feedScoresFetchedAtByCountry: {
              ...state.feedScoresFetchedAtByCountry,
              [normalizedCountry]: Date.now(),
            },
          };
        }),
      markFeedScoresFetched: (country) =>
        set((state) => {
          const normalizedCountry = normalizeCountryScope(country);
          return {
            feedScoresFetchedAtByCountry: {
              ...state.feedScoresFetchedAtByCountry,
              [normalizedCountry]: Date.now(),
            },
          };
        }),
      setTrackerPpGains: (country, gains, fetchedAt = Date.now()) =>
        set((state) => {
          const normalizedCountry = normalizeCountryScope(country);
          const currentEntries = state.trackerPpGainsByCountry[normalizedCountry] ?? {};
          const mergedEntries = {
            ...currentEntries,
            ...Object.fromEntries(
              Object.entries(gains)
                .filter(([, value]) => Number.isFinite(value))
                .map(([scoreId, value]) => [Number(scoreId), { value, fetchedAt }]),
            ),
          };
          const trimmedEntries = Object.fromEntries(
            (Object.entries(mergedEntries) as [string, CachedScoreGain][])
              .sort((a, b) => b[1].fetchedAt - a[1].fetchedAt)
              .slice(0, 300),
          ) as Record<number, CachedScoreGain>;

          return {
            trackerPpGainsByCountry: {
              ...state.trackerPpGainsByCountry,
              [normalizedCountry]: trimmedEntries,
            },
          };
        }),
      setTrackedUserIds: (country, ids) =>
        set((state) => {
          const normalizedCountry = normalizeCountryScope(country);
          return {
            trackedUserIdsByCountry: {
              ...state.trackedUserIdsByCountry,
              [normalizedCountry]: ids,
            },
            trackedUserIdsFetchedAtByCountry: {
              ...state.trackedUserIdsFetchedAtByCountry,
              [normalizedCountry]: Date.now(),
            },
            pollIndexByCountry: {
              ...state.pollIndexByCountry,
              [normalizedCountry]: 0,
            },
          };
        }),
      nextPollIndex: (country) =>
        set((state) => {
          const normalizedCountry = normalizeCountryScope(country);
          return {
            pollIndexByCountry: {
              ...state.pollIndexByCountry,
              [normalizedCountry]: (state.pollIndexByCountry[normalizedCountry] ?? 0) + 1,
            },
          };
        }),
      resetPollIndex: (country) =>
        set((state) => {
          const normalizedCountry = normalizeCountryScope(country);
          return {
            pollIndexByCountry: {
              ...state.pollIndexByCountry,
              [normalizedCountry]: 0,
            },
          };
        }),
    }),
    {
      // v5: home scores/popoffs and rankings persisted shapes changed to
      // lean DTOs; the bump forces returning users to re-fetch instead of
      // rehydrating v4 entries with fat shapes our consumers no longer
      // know how to read.
      name: "mania-hub-cache-v5",
      storage,
      merge: (persistedState, currentState) => {
        const nextState = persistedState && typeof persistedState === "object"
          ? persistedState as Partial<AppState>
          : {};
        const hasPersistedSelectedCountry = typeof nextState.selectedCountry === "string";
        const persistedSelectedCountry = hasPersistedSelectedCountry
          ? normalizeCountryScope(nextState.selectedCountry)
          : null;
        // The country cookie is the source of truth on first load: it's what
        // the server used to render the SSR HTML. The exception is the
        // auto-detected first-visit marker: if an older persisted localStorage
        // preference exists, that preference wins and the cookie is rewritten
        // after hydration.
        const cookieCountry = readCountryCookieClient();
        const autoCountryCookie = readAutoCountryCookieClient();
        const selectedCountry = cookieCountry && !(autoCountryCookie && persistedSelectedCountry)
          ? cookieCountry
          : (persistedSelectedCountry
            ?? (currentState.selectedCountry !== DEFAULT_INITIAL_SCOPE
              ? currentState.selectedCountry
              : DEFAULT_INITIAL_SCOPE));
        const persistedPopoffsByCountry =
          nextState.popoffsByCountry && typeof nextState.popoffsByCountry === "object"
            ? nextState.popoffsByCountry
            : {};
        const persistedPopoffsFetchedAtByCountry =
          nextState.popoffsFetchedAtByCountry && typeof nextState.popoffsFetchedAtByCountry === "object"
            ? nextState.popoffsFetchedAtByCountry
            : {};
        const persistedPopoffsFetchedAtEntries = Object.entries(
          persistedPopoffsFetchedAtByCountry,
        ).filter(([, fetchedAt]) => Number.isFinite(Number(fetchedAt)));

        // Shape guard: during development, HMR can re-key the persist store
        // mid-session and write a stale in-memory shape under the new name
        // (e.g. fat `OsuScore` where the new consumer expects `LeanHomeScore`).
        // On rehydration, drop any country's entries that don't match the
        // current lean shape so the consumer re-fetches instead of rendering
        // objects where it expects strings.
        const isLeanHomeScore = (value: unknown): value is LeanHomeScore => {
          if (!value || typeof value !== "object") return false;
          const score = value as Record<string, unknown>;
          if (!Array.isArray(score.mods)) return false;
          if (score.mods.length > 0 && typeof (score.mods[0] as Record<string, unknown>)?.acronym !== "string") return false;
          return typeof score.displayRank === "string" && typeof score.title === "string";
        };
        const sanitizeByCountry = <T>(
          raw: unknown,
          isValid: (value: unknown) => boolean,
        ): CountryRecord<T[]> => {
          if (!raw || typeof raw !== "object") return {};
          const result: CountryRecord<T[]> = {};
          for (const [country, entries] of Object.entries(raw)) {
            if (!Array.isArray(entries) || entries.length === 0) continue;
            if (!entries.every(isValid)) continue;
            result[country] = entries as T[];
          }
          return result;
        };
        const sanitizedHomeRecentScoresByCountry = sanitizeByCountry<LeanHomeScore>(
          nextState.homeRecentScoresByCountry,
          isLeanHomeScore,
        );
        const sanitizedHomePopoffsByCountry = sanitizeByCountry<LeanHomePopoff>(
          nextState.homePopoffsByCountry,
          (entry) =>
            !!entry &&
            typeof entry === "object" &&
            isLeanHomeScore((entry as { score?: unknown }).score),
        );
        const rankingsIsLean = (ranking: unknown): boolean => {
          if (!Array.isArray(ranking)) return false;
          if (ranking.length === 0) return true;
          const first = ranking[0] as Record<string, unknown> | null;
          const user = first?.user as Record<string, unknown> | undefined;
          // Reject v4 full `OsuUser` shape (has `page`, `badges`, `statistics`)
          // and v5 lean ranking entries that predate replay suggestion banners.
          return !!user &&
            !("page" in user) &&
            !("badges" in user) &&
            !("statistics" in user) &&
            typeof user.cover_url === "string";
        };
        const sanitizedRankingsByCountry: CountryRecord<RankingsResponse> = {};
        if (nextState.rankingsByCountry && typeof nextState.rankingsByCountry === "object") {
          for (const [country, value] of Object.entries(nextState.rankingsByCountry)) {
            if (value && typeof value === "object" && rankingsIsLean((value as RankingsResponse).ranking)) {
              sanitizedRankingsByCountry[country] = value as RankingsResponse;
            }
          }
        }
        // Drop fetchedAt timestamps for any country whose entries got
        // sanitized out, otherwise the consumer's stale-check treats the
        // dropped country as fresh and never refetches.
        const filterFetchedAtByCountry = (
          raw: unknown,
          validCountries: CountryRecord<unknown>,
        ): CountryRecord<number> => {
          if (!raw || typeof raw !== "object") return {};
          const result: CountryRecord<number> = {};
          for (const [country, ts] of Object.entries(raw)) {
            if (!(country in validCountries)) continue;
            if (!Number.isFinite(Number(ts))) continue;
            result[country] = Number(ts);
          }
          return result;
        };
        const sanitizedHomeRecentScoresFetchedAtByCountry = filterFetchedAtByCountry(
          nextState.homeRecentScoresFetchedAtByCountry,
          sanitizedHomeRecentScoresByCountry,
        );
        const sanitizedHomePopoffsFetchedAtByCountry = filterFetchedAtByCountry(
          nextState.homePopoffsFetchedAtByCountry,
          sanitizedHomePopoffsByCountry,
        );
        const sanitizedRankingsFetchedAtByCountry = filterFetchedAtByCountry(
          nextState.rankingsFetchedAtByCountry,
          sanitizedRankingsByCountry,
        );

        return {
          ...currentState,
          ...nextState,
          // If the user changed country before persist hydration finished, do not clobber
          // that live selection with the older value from storage.
          selectedCountry,
          // Override the spread above with the shape-validated versions so
          // stale/mismatched persisted entries don't make it to consumers.
          rankingsByCountry: sanitizedRankingsByCountry,
          rankingsFetchedAtByCountry: sanitizedRankingsFetchedAtByCountry,
          homeRecentScoresByCountry: sanitizedHomeRecentScoresByCountry,
          homeRecentScoresFetchedAtByCountry: sanitizedHomeRecentScoresFetchedAtByCountry,
          homePopoffsByCountry: sanitizedHomePopoffsByCountry,
          homePopoffsFetchedAtByCountry: sanitizedHomePopoffsFetchedAtByCountry,
          // Dedicated key wins; the `nextState.themeHue` fallback only matters
          // for returning users whose theme still lives in the legacy blob and
          // haven't picked a color since this migration landed.
          themeHue: readThemeHueFromStorage()
            ?? clampThemeHue(nextState.themeHue ?? currentState.themeHue),
          showDanEstimates: typeof nextState.showDanEstimates === "boolean"
            ? nextState.showDanEstimates
            : currentState.showDanEstimates,
          // Dedicated key wins. The legacy blob fallback only matters for
          // returning users whose accents still live in `mania-hub-cache-v5`
          // and haven't been re-fetched since this migration landed; those
          // entries get copied over to the dedicated key on first hydration.
          avatarAccents: (() => {
            const fromDedicated = readAvatarAccentsFromStorage();
            if (Object.keys(fromDedicated).length > 0) return fromDedicated;
            const migrated = filterFreshAvatarAccents(nextState.avatarAccents);
            if (Object.keys(migrated).length > 0) writeAvatarAccentsToStorage(migrated);
            return migrated;
          })(),
          topPlaysRangeByCountry: currentState.topPlaysRangeByCountry,
          snipesFiltersByCountry: currentState.snipesFiltersByCountry,
          // Seeded synchronously from the dedicated key and written there on
          // every change, so the pre-hydration value is already authoritative.
          hiddenUsers: currentState.hiddenUsers,
          // Keep persisted top-plays data even when stale so the route can render it
          // immediately after a reload and revalidate in the background.
          popoffsByCountry: persistedPopoffsByCountry as CountryRecord<CachedPopoff[]>,
          popoffsFetchedAtByCountry: Object.fromEntries(
            persistedPopoffsFetchedAtEntries.map(([country, fetchedAt]) => [country, Number(fetchedAt)]),
          ) as CountryRecord<number>,
          popoffsWindowByCountry: (() => {
            const raw = nextState.popoffsWindowByCountry;
            if (!raw || typeof raw !== "object") return {};
            const valid: CountryRecord<TopPlaysRange> = {};
            for (const [country, value] of Object.entries(raw)) {
              if (value === "24h" || value === "3d" || value === "7d" || value === "30d") {
                valid[country] = value;
              }
            }
            return valid;
          })(),
          trackerPpGainsByCountry: Object.fromEntries(
            Object.entries(
              nextState.trackerPpGainsByCountry && typeof nextState.trackerPpGainsByCountry === "object"
                ? nextState.trackerPpGainsByCountry
                : {},
            ).map(([country, entries]) => [
              country,
              Object.fromEntries(
                Object.entries(entries && typeof entries === "object" ? entries : {}).filter(([, entry]) => {
                  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
                  const fetchedAt = (entry as CachedScoreGain).fetchedAt;
                  const value = (entry as CachedScoreGain).value;
                  return Number.isFinite(fetchedAt) &&
                    Number.isFinite(value) &&
                    Date.now() - fetchedAt < TRACKER_PP_GAIN_CLIENT_TTL;
                }),
              ),
            ]),
          ) as CountryRecord<Record<number, CachedScoreGain>>,
        };
      },
      partialize: (state) => ({
        selectedCountry: state.selectedCountry,
        showDanEstimates: state.showDanEstimates,
        // themeHue is persisted separately via THEME_HUE_STORAGE_KEY so a
        // QuotaExceededError on this big blob (common on mobile Safari) can't
        // drop a theme change on the floor.
        // avatarAccents is persisted separately via AVATAR_ACCENTS_STORAGE_KEY
        // for the same reason, plus to bypass the 250ms persist debounce that
        // mobile reload was eating before pagehide fired.
        rankingsByCountry: state.rankingsByCountry,
        rankingsFetchedAtByCountry: state.rankingsFetchedAtByCountry,
        rankHistories: state.rankHistories,
        rankHistoriesFetchedAt: state.rankHistoriesFetchedAt,
        homeRecentScoresByCountry: state.homeRecentScoresByCountry,
        homeRecentScoresFetchedAtByCountry: state.homeRecentScoresFetchedAtByCountry,
        homePopoffsByCountry: state.homePopoffsByCountry,
        homePopoffsFetchedAtByCountry: state.homePopoffsFetchedAtByCountry,
        // topPlaysRangeByCountry and snipesFiltersByCountry are persisted
        // separately in small dedicated localStorage keys so preference writes
        // survive even if the large cache blob hits quota.
        popoffsByCountry: state.popoffsByCountry,
        popoffsFetchedAtByCountry: state.popoffsFetchedAtByCountry,
        popoffsWindowByCountry: state.popoffsWindowByCountry,
        trackerPpGainsByCountry: state.trackerPpGainsByCountry,
        feedScoresByCountry: Object.fromEntries(
          Object.entries(state.feedScoresByCountry).map(([country, scores]) => [
            country,
            scores.length > TRACKER_FEED_PERSIST_LIMIT ? scores.slice(0, TRACKER_FEED_PERSIST_LIMIT) : scores,
          ]),
        ),
        feedScoresFetchedAtByCountry: state.feedScoresFetchedAtByCountry,
        // mapsDataByCountry and snipesByCountry are intentionally NOT
        // persisted. They can balloon past the ~5MB localStorage quota
        // once more than a country or two accumulates (the maps beatmapset
        // pool alone is ~1-2MB per country; the snipes log is up to
        // 500 entries × ~1KB per country). The server cache serves them
        // in <100ms on hydration so the round-trip is cheap.
        // feedScoresByCountry IS persisted, but trimmed to TRACKER_FEED_PERSIST_LIMIT
        // (newest-first) above so the blob stays small. The full in-memory feed
        // (up to TRACKER_FEED_SCORE_LIMIT) is only for the current session.
        trackedUserIdsByCountry: state.trackedUserIdsByCountry,
        trackedUserIdsFetchedAtByCountry: state.trackedUserIdsFetchedAtByCountry,
        pollIndexByCountry: state.pollIndexByCountry,
      }),
    },
  ),
);

// Migration sync: returning users may have a localStorage preference but no
// cookie (because the cookie was added in this commit). After persist has
// hydrated the store on the client, write the cookie to match the store so
// the very next reload renders the right country server-side.
if (typeof window !== "undefined") {
  const syncCookieToStore = () => {
    const current = useAppStore.getState().selectedCountry;
    if (readCountryCookieClient() !== current || readAutoCountryCookieClient()) {
      writeCountryCookieClient(current);
    }
  };
  const syncThemeHueToDom = () => {
    applyThemeHueToDom(useAppStore.getState().themeHue);
  };
  if (useAppStore.persist.hasHydrated()) {
    syncCookieToStore();
    syncThemeHueToDom();
  } else {
    useAppStore.persist.onFinishHydration(() => {
      syncCookieToStore();
      syncThemeHueToDom();
    });
  }
}

// Returns false during SSR and the very first client render, then true once
// Zustand persist has synced from localStorage. Mostly used internally by
// useSelectedCountry to know when to switch from the SSR-provided context
// value to the live store value.
//
// Implemented via useSyncExternalStore so the initial client render after a
// nav reads the real hydration state synchronously — a plain useState+effect
// version flips the value inside an effect, forcing every page that uses
// useSelectedCountry to re-render a second time on mount.
function subscribeHydration(cb: () => void): () => void {
  return useAppStore.persist.onFinishHydration(cb);
}
function getHydrationSnapshot(): boolean {
  return useAppStore.persist.hasHydrated();
}
function getHydrationServerSnapshot(): boolean {
  return false;
}
export function useHasHydrated(): boolean {
  return useSyncExternalStore(subscribeHydration, getHydrationSnapshot, getHydrationServerSnapshot);
}

// Read the currently-selected country with no SSR/hydration flash.
//
// On the server (and during the very first client render that must match
// the SSR HTML), this returns the value the server resolved from the request
// cookie via InitialCountryContext. Once Zustand persist has finished syncing
// from localStorage, it switches to reading the live store value so that
// in-app country changes propagate normally.
export function useSelectedCountry(): string {
  const fromContext = useContext(InitialCountryContext);
  const fromStore = useAppStore((state) => state.selectedCountry);
  const hydrated = useHasHydrated();
  return hydrated ? fromStore : fromContext;
}

// Hidden-player user ids as a Set for cheap membership checks while filtering
// rankings/tracker/top-plays/snipes/home/maps. The Set is rebuilt only when the
// hidden-users record actually changes, so consumers don't re-render on every
// unrelated store update.
export function useHiddenUserIds(): Set<number> {
  const hiddenUsers = useAppStore((state) => state.hiddenUsers);
  return useMemo(() => new Set(Object.keys(hiddenUsers).map(Number)), [hiddenUsers]);
}
