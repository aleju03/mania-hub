import { useContext, useSyncExternalStore } from "react";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { getAvatarAccentStoreKey } from "./lib/avatar-accent";
import { DEFAULT_COUNTRY_CODE, normalizeCountryCode } from "./lib/country";
import { InitialCountryContext } from "./lib/country-context";
import { readCountryCookieClient, writeCountryCookieClient } from "./lib/country-cookie";
import { getScoreIdentity, getScoreTimeMs } from "./lib/score";
import type {
  OsuScore,
  RankingsResponse,
  CountryMapsData,
  LeanHomeScore,
  LeanHomePopoff,
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
export const TOP_PLAYS_RANGE_STORAGE_KEY = "mania-hub-top-plays-range-v1";
export const DEFAULT_THEME_HUE = 333;

function applyThemeHueToDom(hue: number): void {
  if (typeof document === "undefined") return;
  document.documentElement.style.setProperty("--theme-hue", String(hue));
  if (hue === DEFAULT_THEME_HUE) {
    document.documentElement.style.removeProperty("--theme-hue-mix");
  } else {
    document.documentElement.style.setProperty("--theme-hue-mix", "1");
  }
}

function clampThemeHue(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return DEFAULT_THEME_HUE;
  const rounded = Math.round(n);
  return ((rounded % 360) + 360) % 360;
}

export interface CachedPlayer {
  id: number;
  username: string;
  avatar_url: string;
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

type CountryRecord<T> = Record<string, T>;

interface AppState {
  selectedCountry: string;
  themeHue: number;
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
  popoffsByCountry: CountryRecord<CachedPopoff[]>;
  popoffsFetchedAtByCountry: CountryRecord<number>;
  mapsDataByCountry: CountryRecord<CountryMapsData>;
  mapsDataFetchedAtByCountry: CountryRecord<number>;
  feedScoresByCountry: CountryRecord<OsuScore[]>;
  feedScoresFetchedAtByCountry: CountryRecord<number>;
  trackerPpGainsByCountry: CountryRecord<Record<number, CachedScoreGain>>;
  trackedUserIdsByCountry: CountryRecord<number[]>;
  trackedUserIdsFetchedAtByCountry: CountryRecord<number>;
  pollIndexByCountry: CountryRecord<number>;
  setSelectedCountry: (country: string) => void;
  setThemeHue: (hue: number) => void;
  resetThemeHue: () => void;
  setAvatarAccents: (accents: Record<string, string | null>, fetchedAt?: number) => void;
  setRankings: (country: string, rankings: RankingsResponse) => void;
  setRankHistories: (histories: Record<number, number[]>) => void;
  setHomeRecentScores: (country: string, scores: LeanHomeScore[]) => void;
  setHomePopoffs: (country: string, popoffs: LeanHomePopoff[]) => void;
  setTopPlaysRange: (country: string, range: TopPlaysRange) => void;
  setPopoffs: (country: string, popoffs: CachedPopoff[]) => void;
  setMapsData: (country: string, data: CountryMapsData) => void;
  addFeedScores: (country: string, scores: OsuScore[]) => void;
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
        timer = null;
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
            warnStorageIssue(`write "${name}"`, error);
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

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
      selectedCountry: initialClientCountry ?? DEFAULT_COUNTRY_CODE,
      themeHue: DEFAULT_THEME_HUE,
      avatarAccents: {},
      rankingsByCountry: {},
      rankingsFetchedAtByCountry: {},
      rankHistories: {},
      rankHistoriesFetchedAt: {},
      homeRecentScoresByCountry: {},
      homeRecentScoresFetchedAtByCountry: {},
      homePopoffsByCountry: {},
      homePopoffsFetchedAtByCountry: {},
      topPlaysRangeByCountry: readTopPlaysRangeByCountry(),
      popoffsByCountry: {},
      popoffsFetchedAtByCountry: {},
      mapsDataByCountry: {},
      mapsDataFetchedAtByCountry: {},
      feedScoresByCountry: {},
      feedScoresFetchedAtByCountry: {},
      trackerPpGainsByCountry: {},
      trackedUserIdsByCountry: {},
      trackedUserIdsFetchedAtByCountry: {},
      pollIndexByCountry: {},
      setSelectedCountry: (country) => {
        const normalized = normalizeCountryCode(country);
        writeCountryCookieClient(normalized);
        set({ selectedCountry: normalized });
      },
      setThemeHue: (hue) => {
        const clamped = clampThemeHue(hue);
        applyThemeHueToDom(clamped);
        set({ themeHue: clamped });
      },
      resetThemeHue: () => {
        applyThemeHueToDom(DEFAULT_THEME_HUE);
        set({ themeHue: DEFAULT_THEME_HUE });
      },
      setAvatarAccents: (accents, fetchedAt = Date.now()) =>
        set((state) => ({
          avatarAccents: {
            ...state.avatarAccents,
            ...Object.fromEntries(
              Object.entries(accents).map(([url, accent]) => [
                getAvatarAccentStoreKey(url),
                { value: accent, fetchedAt },
              ]),
            ),
          },
        })),
      setRankings: (country, rankings) =>
        set((state) => {
          const normalizedCountry = normalizeCountryCode(country);
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
          const normalizedCountry = normalizeCountryCode(country);
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
          const normalizedCountry = normalizeCountryCode(country);
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
          const normalizedCountry = normalizeCountryCode(country);
          const nextTopPlaysRangeByCountry = {
            ...state.topPlaysRangeByCountry,
            [normalizedCountry]: range,
          };

          writeTopPlaysRangeByCountry(nextTopPlaysRangeByCountry);

          return {
            topPlaysRangeByCountry: nextTopPlaysRangeByCountry,
          };
        }),
      setPopoffs: (country, popoffs) =>
        set((state) => {
          const normalizedCountry = normalizeCountryCode(country);
          return {
            popoffsByCountry: {
              ...state.popoffsByCountry,
              [normalizedCountry]: popoffs,
            },
            popoffsFetchedAtByCountry: {
              ...state.popoffsFetchedAtByCountry,
              [normalizedCountry]: Date.now(),
            },
          };
        }),
      setMapsData: (country, data) =>
        set((state) => {
          const normalizedCountry = normalizeCountryCode(country);
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
      addFeedScores: (country, scores) =>
        set((state) => {
          const normalizedCountry = normalizeCountryCode(country);
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
            .slice(0, 100);

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
          const normalizedCountry = normalizeCountryCode(country);
          return {
            feedScoresFetchedAtByCountry: {
              ...state.feedScoresFetchedAtByCountry,
              [normalizedCountry]: Date.now(),
            },
          };
        }),
      setTrackerPpGains: (country, gains, fetchedAt = Date.now()) =>
        set((state) => {
          const normalizedCountry = normalizeCountryCode(country);
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
            Object.entries(mergedEntries)
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
          const normalizedCountry = normalizeCountryCode(country);
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
          const normalizedCountry = normalizeCountryCode(country);
          return {
            pollIndexByCountry: {
              ...state.pollIndexByCountry,
              [normalizedCountry]: (state.pollIndexByCountry[normalizedCountry] ?? 0) + 1,
            },
          };
        }),
      resetPollIndex: (country) =>
        set((state) => {
          const normalizedCountry = normalizeCountryCode(country);
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
        const persistedSelectedCountry = normalizeCountryCode(nextState.selectedCountry);
        // The cookie is the source of truth on first load: it's what the
        // server used to render the SSR HTML. If it disagrees with the
        // localStorage value, the cookie wins. Falls back to the in-flight
        // store value (user mid-session) and finally the persisted value.
        const cookieCountry = readCountryCookieClient();
        const selectedCountry = cookieCountry
          ?? (currentState.selectedCountry !== DEFAULT_COUNTRY_CODE
            ? currentState.selectedCountry
            : persistedSelectedCountry);
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
          if (score.mods.length > 0 && typeof score.mods[0] !== "string") return false;
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
          // Reject v4 full `OsuUser` shape (has `page`, `badges`, `statistics`).
          return !!user && !("page" in user) && !("badges" in user) && !("statistics" in user);
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
          themeHue: clampThemeHue(nextState.themeHue ?? currentState.themeHue),
          avatarAccents: Object.fromEntries(
            Object.entries(
              nextState.avatarAccents && typeof nextState.avatarAccents === "object"
                ? nextState.avatarAccents
                : {},
            ).filter(([, entry]) => {
              if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
              const fetchedAt = (entry as CachedAvatarAccent).fetchedAt;
              const value = (entry as CachedAvatarAccent).value;
                const ttl = value === null ? AVATAR_ACCENT_FAILURE_TTL : AVATAR_ACCENT_CLIENT_TTL;
              return Number.isFinite(fetchedAt) && Date.now() - fetchedAt < ttl;
            }),
          ) as Record<string, CachedAvatarAccent>,
          topPlaysRangeByCountry: currentState.topPlaysRangeByCountry,
          // Keep persisted top-plays data even when stale so the route can render it
          // immediately after a reload and revalidate in the background.
          popoffsByCountry: persistedPopoffsByCountry as CountryRecord<CachedPopoff[]>,
          popoffsFetchedAtByCountry: Object.fromEntries(
            persistedPopoffsFetchedAtEntries.map(([country, fetchedAt]) => [country, Number(fetchedAt)]),
          ) as CountryRecord<number>,
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
        themeHue: state.themeHue,
        avatarAccents: state.avatarAccents,
        rankingsByCountry: state.rankingsByCountry,
        rankingsFetchedAtByCountry: state.rankingsFetchedAtByCountry,
        rankHistories: state.rankHistories,
        rankHistoriesFetchedAt: state.rankHistoriesFetchedAt,
        homeRecentScoresByCountry: state.homeRecentScoresByCountry,
        homeRecentScoresFetchedAtByCountry: state.homeRecentScoresFetchedAtByCountry,
        homePopoffsByCountry: state.homePopoffsByCountry,
        homePopoffsFetchedAtByCountry: state.homePopoffsFetchedAtByCountry,
        popoffsByCountry: state.popoffsByCountry,
        popoffsFetchedAtByCountry: state.popoffsFetchedAtByCountry,
        trackerPpGainsByCountry: state.trackerPpGainsByCountry,
        // mapsDataByCountry and feedScoresByCountry are intentionally NOT
        // persisted. Both can balloon past the ~5MB localStorage quota once
        // more than a country or two accumulates (the maps beatmapset pool
        // alone is ~1-2MB per country). The server cache serves them in
        // <100ms on hydration so the round-trip is cheap.
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
    if (readCountryCookieClient() !== current) {
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
