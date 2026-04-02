import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { getAvatarAccentStoreKey } from "./lib/avatar-accent";
import { getScoreIdentity, getScoreTimeMs } from "./lib/score";
import type { OsuScore, RankingsResponse } from "./lib/types";

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
  time: string;
}

interface AppState {
  avatarAccents: Record<string, string | null>;
  crRankings: RankingsResponse | null;
  crRankingsFetchedAt: number | null;
  rankHistories: Record<number, number[]>;
  rankHistoriesFetchedAt: number | null;
  homeRecentScores: OsuScore[];
  homeRecentScoresFetchedAt: number | null;
  homePopoffs: CachedHomePopoff[];
  homePopoffsFetchedAt: number | null;
  popoffs: CachedPopoff[];
  popoffsFetchedAt: number | null;
  // Score feed
  feedScores: OsuScore[];
  feedScoresFetchedAt: number | null;
  trackedUserIds: number[];
  trackedUserIdsFetchedAt: number | null;
  pollIndex: number;
  setAvatarAccents: (accents: Record<string, string | null>) => void;
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
      rankHistoriesFetchedAt: null,
      homeRecentScores: [],
      homeRecentScoresFetchedAt: null,
      homePopoffs: [],
      homePopoffsFetchedAt: null,
      popoffs: [],
      popoffsFetchedAt: null,
      feedScores: [],
      feedScoresFetchedAt: null,
      trackedUserIds: [],
      trackedUserIdsFetchedAt: null,
      pollIndex: 0,
      setAvatarAccents: (accents) =>
        set((state) => ({
          avatarAccents: {
            ...state.avatarAccents,
            ...Object.fromEntries(
              Object.entries(accents).map(([url, accent]) => [getAvatarAccentStoreKey(url), accent]),
            ),
          },
        })),
      setCrRankings: (rankings) =>
        set({
          crRankings: rankings,
          crRankingsFetchedAt: Date.now(),
        }),
      setRankHistories: (histories) =>
        set((state) => ({
          rankHistories: { ...state.rankHistories, ...histories },
          rankHistoriesFetchedAt: Date.now(),
        })),
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
      name: "mania-hub-cache-v1",
      storage,
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
        feedScores: state.feedScores,
        feedScoresFetchedAt: state.feedScoresFetchedAt,
        trackedUserIds: state.trackedUserIds,
        trackedUserIdsFetchedAt: state.trackedUserIdsFetchedAt,
      }),
    },
  ),
);
