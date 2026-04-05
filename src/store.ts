import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { getAvatarAccentStoreKey } from "./lib/avatar-accent";
import { getScoreIdentity, getScoreTimeMs } from "./lib/score";
import type { OsuScore, RankingsResponse, CountryMapsData } from "./lib/types";

export interface CachedAvatarAccent {
  fetchedAt: number;
  value: string | null;
}

export const AVATAR_ACCENT_CLIENT_TTL = 24 * 60 * 60 * 1000;

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

interface AppState {
  avatarAccents: Record<string, CachedAvatarAccent>;
  crRankings: RankingsResponse | null;
  crRankingsFetchedAt: number | null;
  rankHistories: Record<number, number[]>;
  rankHistoriesFetchedAt: Record<number, number>;
  homeRecentScores: OsuScore[];
  homeRecentScoresFetchedAt: number | null;
  homePopoffs: CachedHomePopoff[];
  homePopoffsFetchedAt: number | null;
  popoffs: CachedPopoff[];
  popoffsFetchedAt: number | null;
  // Maps
  mapsData: CountryMapsData | null;
  mapsDataFetchedAt: number | null;
  setMapsData: (data: CountryMapsData) => void;
  // Score feed
  feedScores: OsuScore[];
  feedScoresFetchedAt: number | null;
  trackedUserIds: number[];
  trackedUserIdsFetchedAt: number | null;
  pollIndex: number;
  setAvatarAccents: (accents: Record<string, string | null>, fetchedAt?: number) => void;
  setCrRankings: (rankings: RankingsResponse) => void;
  setRankHistories: (histories: Record<number, number[]>) => void;
  setHomeRecentScores: (scores: OsuScore[]) => void;
  setHomePopoffs: (popoffs: CachedHomePopoff[]) => void;
  setPopoffs: (popoffs: CachedPopoff[]) => void;
  addFeedScores: (scores: OsuScore[]) => void;
  markFeedScoresFetched: () => void;
  setTrackedUserIds: (ids: number[]) => void;
  nextPollIndex: () => void;
}

const storage = typeof window !== "undefined"
  ? createJSONStorage(() => localStorage)
  : undefined;

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
      crRankings: null,
      avatarAccents: {},
      crRankingsFetchedAt: null,
      rankHistories: {},
      rankHistoriesFetchedAt: {},
      homeRecentScores: [],
      homeRecentScoresFetchedAt: null,
      homePopoffs: [],
      homePopoffsFetchedAt: null,
      popoffs: [],
      popoffsFetchedAt: null,
      mapsData: null,
      mapsDataFetchedAt: null,
      setMapsData: (data) =>
        set({
          mapsData: data,
          mapsDataFetchedAt: Date.now(),
        }),
      feedScores: [],
      feedScoresFetchedAt: null,
      trackedUserIds: [],
      trackedUserIdsFetchedAt: null,
      pollIndex: 0,
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
      setCrRankings: (rankings) =>
        set({
          crRankings: rankings,
          crRankingsFetchedAt: Date.now(),
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
      setHomeRecentScores: (scores) =>
        set({
          homeRecentScores: scores,
          homeRecentScoresFetchedAt: Date.now(),
        }),
      setHomePopoffs: (popoffs) =>
        set({
          homePopoffs: popoffs,
          homePopoffsFetchedAt: Date.now(),
        }),
      setPopoffs: (popoffs) =>
        set({
          popoffs,
          popoffsFetchedAt: Date.now(),
        }),
      addFeedScores: (scores) =>
        set((state) => {
          const seen = new Set<string>();
          const merged = [...scores, ...state.feedScores]
            .sort((a, b) => getScoreTimeMs(b) - getScoreTimeMs(a))
            .filter((score) => {
              const key = getScoreIdentity(score);
              if (seen.has(key)) return false;
              seen.add(key);
              return true;
            })
            .slice(0, 100);

          return {
            feedScores: merged,
            feedScoresFetchedAt: Date.now(),
          };
        }),
      markFeedScoresFetched: () =>
        set({
          feedScoresFetchedAt: Date.now(),
        }),
      setTrackedUserIds: (ids) =>
        set({
          trackedUserIds: ids,
          trackedUserIdsFetchedAt: Date.now(),
        }),
      nextPollIndex: () => set((state) => ({ pollIndex: state.pollIndex + 1 })),
    }),
    {
      name: "mania-hub-cache-v3",
      storage,
      merge: (persistedState, currentState) => {
        const nextState = persistedState && typeof persistedState === "object"
          ? persistedState as Partial<AppState>
          : {};

        return {
          ...currentState,
          ...nextState,
          avatarAccents: Object.fromEntries(
            Object.entries(
              nextState.avatarAccents && typeof nextState.avatarAccents === "object"
                ? nextState.avatarAccents
                : {},
            ).filter(([, entry]) => {
              if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
              const fetchedAt = (entry as CachedAvatarAccent).fetchedAt;
              return Number.isFinite(fetchedAt) && Date.now() - fetchedAt < AVATAR_ACCENT_CLIENT_TTL;
            }),
          ) as Record<string, CachedAvatarAccent>,
        };
      },
      partialize: (state) => ({
        avatarAccents: state.avatarAccents,
        crRankings: state.crRankings,
        crRankingsFetchedAt: state.crRankingsFetchedAt,
        rankHistories: state.rankHistories,
        rankHistoriesFetchedAt: state.rankHistoriesFetchedAt,
        homeRecentScores: state.homeRecentScores,
        homeRecentScoresFetchedAt: state.homeRecentScoresFetchedAt,
        homePopoffs: state.homePopoffs,
        homePopoffsFetchedAt: state.homePopoffsFetchedAt,
        popoffs: state.popoffs,
        popoffsFetchedAt: state.popoffsFetchedAt,
        mapsData: state.mapsData,
        mapsDataFetchedAt: state.mapsDataFetchedAt,
        feedScores: state.feedScores,
        feedScoresFetchedAt: state.feedScoresFetchedAt,
        trackedUserIds: state.trackedUserIds,
        trackedUserIdsFetchedAt: state.trackedUserIdsFetchedAt,
      }),
    },
  ),
);
