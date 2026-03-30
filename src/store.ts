import { create } from "zustand";
import type { OsuScore } from "./lib/types";

interface AppState {
  // Score feed
  feedScores: OsuScore[];
  trackedUserIds: number[];
  pollIndex: number;
  addFeedScores: (scores: OsuScore[]) => void;
  setTrackedUserIds: (ids: number[]) => void;
  nextPollIndex: () => void;
}

export const useAppStore = create<AppState>((set) => ({
  feedScores: [],
  trackedUserIds: [],
  pollIndex: 0,
  addFeedScores: (scores) =>
    set((s) => {
      const existing = new Set(s.feedScores.map((sc) => sc.id));
      const newScores = scores.filter((sc) => !existing.has(sc.id));
      const merged = [...newScores, ...s.feedScores]
        .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
        .slice(0, 100);
      return { feedScores: merged };
    }),
  setTrackedUserIds: (ids) => set({ trackedUserIds: ids }),
  nextPollIndex: () => set((s) => ({ pollIndex: s.pollIndex + 1 })),
}));
