import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { getAvatarAccentStoreKey } from "./lib/avatar-accent";
import { DEFAULT_COUNTRY_CODE, normalizeCountryCode } from "./lib/country";
import { getScoreIdentity, getScoreTimeMs } from "./lib/score";
import type { OsuScore, RankingsResponse, CountryMapsData } from "./lib/types";

export interface CachedAvatarAccent {
  fetchedAt: number;
  value: string | null;
}

export const AVATAR_ACCENT_CLIENT_TTL = 24 * 60 * 60 * 1000;
export const AVATAR_ACCENT_FAILURE_TTL = 5 * 60 * 1000;

export interface CachedPlayer {
  id: number;
  username: string;
  avatar_url: string;
}

export interface CachedHomePopoff {
  user: { username: string; avatar_url: string };
  score: OsuScore;
}

export interface CachedPopoff {
  user: CachedPlayer;
  score: OsuScore;
  pp: number;
  weightedPP: number;
  ppGain: number;
  time: string;
}

type CountryRecord<T> = Record<string, T>;

interface AppState {
  selectedCountry: string;
  avatarAccents: Record<string, CachedAvatarAccent>;
  rankingsByCountry: CountryRecord<RankingsResponse>;
  rankingsFetchedAtByCountry: CountryRecord<number>;
  rankHistories: Record<number, number[]>;
  rankHistoriesFetchedAt: Record<number, number>;
  homeRecentScoresByCountry: CountryRecord<OsuScore[]>;
  homeRecentScoresFetchedAtByCountry: CountryRecord<number>;
  homePopoffsByCountry: CountryRecord<CachedHomePopoff[]>;
  homePopoffsFetchedAtByCountry: CountryRecord<number>;
  popoffsByCountry: CountryRecord<CachedPopoff[]>;
  popoffsFetchedAtByCountry: CountryRecord<number>;
  mapsDataByCountry: CountryRecord<CountryMapsData>;
  mapsDataFetchedAtByCountry: CountryRecord<number>;
  feedScoresByCountry: CountryRecord<OsuScore[]>;
  feedScoresFetchedAtByCountry: CountryRecord<number>;
  trackedUserIdsByCountry: CountryRecord<number[]>;
  trackedUserIdsFetchedAtByCountry: CountryRecord<number>;
  pollIndexByCountry: CountryRecord<number>;
  setSelectedCountry: (country: string) => void;
  setAvatarAccents: (accents: Record<string, string | null>, fetchedAt?: number) => void;
  setRankings: (country: string, rankings: RankingsResponse) => void;
  setRankHistories: (histories: Record<number, number[]>) => void;
  setHomeRecentScores: (country: string, scores: OsuScore[]) => void;
  setHomePopoffs: (country: string, popoffs: CachedHomePopoff[]) => void;
  setPopoffs: (country: string, popoffs: CachedPopoff[]) => void;
  setMapsData: (country: string, data: CountryMapsData) => void;
  addFeedScores: (country: string, scores: OsuScore[]) => void;
  markFeedScoresFetched: (country: string) => void;
  setTrackedUserIds: (country: string, ids: number[]) => void;
  nextPollIndex: (country: string) => void;
  resetPollIndex: (country: string) => void;
}

const storage = typeof window !== "undefined"
  ? createJSONStorage(() => localStorage)
  : undefined;

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
      selectedCountry: DEFAULT_COUNTRY_CODE,
      avatarAccents: {},
      rankingsByCountry: {},
      rankingsFetchedAtByCountry: {},
      rankHistories: {},
      rankHistoriesFetchedAt: {},
      homeRecentScoresByCountry: {},
      homeRecentScoresFetchedAtByCountry: {},
      homePopoffsByCountry: {},
      homePopoffsFetchedAtByCountry: {},
      popoffsByCountry: {},
      popoffsFetchedAtByCountry: {},
      mapsDataByCountry: {},
      mapsDataFetchedAtByCountry: {},
      feedScoresByCountry: {},
      feedScoresFetchedAtByCountry: {},
      trackedUserIdsByCountry: {},
      trackedUserIdsFetchedAtByCountry: {},
      pollIndexByCountry: {},
      setSelectedCountry: (country) =>
        set({
          selectedCountry: normalizeCountryCode(country),
        }),
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
      name: "mania-hub-cache-v4",
      storage,
      merge: (persistedState, currentState) => {
        const nextState = persistedState && typeof persistedState === "object"
          ? persistedState as Partial<AppState>
          : {};

        return {
          ...currentState,
          ...nextState,
          selectedCountry: normalizeCountryCode(nextState.selectedCountry),
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
        };
      },
      partialize: (state) => ({
        selectedCountry: state.selectedCountry,
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
        mapsDataByCountry: state.mapsDataByCountry,
        mapsDataFetchedAtByCountry: state.mapsDataFetchedAtByCountry,
        feedScoresByCountry: state.feedScoresByCountry,
        feedScoresFetchedAtByCountry: state.feedScoresFetchedAtByCountry,
        trackedUserIdsByCountry: state.trackedUserIdsByCountry,
        trackedUserIdsFetchedAtByCountry: state.trackedUserIdsFetchedAtByCountry,
        pollIndexByCountry: state.pollIndexByCountry,
      }),
    },
  ),
);
