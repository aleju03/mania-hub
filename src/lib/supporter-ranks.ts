// A supporter's rank: one step for every month in a row they have been a
// supporter, from Copper on their first day to Holo after eleven months, where
// it stays. A lapse ends the run, and the next one starts again at Copper.
//
// The backend sends only when the current run began (`runStartedAt`); the rank
// is worked out here, so a cached look keeps counting.

import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";

const DAY_MS = 24 * 60 * 60 * 1000;
/* A month of supporter time, the same 30 days $3 buys. */
export const SUPPORTER_RANK_MONTH_MS = 30 * DAY_MS;

export interface SupporterRankDef {
  id: string;
  name: MessageDescriptor;
  /* The badge's fill, light to dark across it. */
  stops: [string, string, string, string];
  /* The heart on it. */
  ink: string;
  /* The colour the rank's name is written in. */
  accent: string;
}

export const SUPPORTER_RANKS: readonly SupporterRankDef[] = [
  { id: "copper", name: msg`Copper`, stops: ["#f3a98a", "#b5532f", "#e88f6a", "#6e2a12"], ink: "#4a1a08", accent: "#f0a07e" },
  { id: "bronze", name: msg`Bronze`, stops: ["#f0c48a", "#a8702c", "#e3b070", "#6a4010"], ink: "#4a2a06", accent: "#e8b878" },
  { id: "steel", name: msg`Steel`, stops: ["#e6edf2", "#6f7d8a", "#c9d3dc", "#3b444d"], ink: "#22292f", accent: "#b8c4cf" },
  { id: "silver", name: msg`Silver`, stops: ["#ffffff", "#a3afbd", "#eef3f8", "#66717f"], ink: "#38414c", accent: "#e2e8ef" },
  { id: "obsidian", name: msg`Obsidian`, stops: ["#6b5a8a", "#15121c", "#3a3150", "#050408"], ink: "#b9a8e0", accent: "#b9a8e0" },
  { id: "gold", name: msg({ message: "Gold", context: "supporter rank" }), stops: ["#fff2b0", "#e0a21e", "#ffe07a", "#9a5d00"], ink: "#6b3c00", accent: "#ffd56b" },
  { id: "sapphire", name: msg`Sapphire`, stops: ["#b8d4ff", "#2b56d6", "#7fa8ff", "#0f2580"], ink: "#0a1850", accent: "#8fb2ff" },
  { id: "ruby", name: msg`Ruby`, stops: ["#ffb3c0", "#d1183f", "#ff6f8a", "#6e0019"], ink: "#4a0010", accent: "#ff6f8a" },
  { id: "emerald", name: msg`Emerald`, stops: ["#b6ffd9", "#0aa66a", "#5cf0b0", "#00593a"], ink: "#003a24", accent: "#5cf0b0" },
  { id: "amethyst", name: msg`Amethyst`, stops: ["#e7c8ff", "#8a3ad9", "#c48cff", "#3e0f75"], ink: "#2a0850", accent: "#c48cff" },
  { id: "diamond", name: msg`Diamond`, stops: ["#ffffff", "#bfe9ff", "#ffffff", "#8fb8d6"], ink: "#2c4a63", accent: "#cdeeff" },
  { id: "holo", name: msg`Holo`, stops: ["#ff8ad0", "#b48cff", "#7fe6ff", "#c6ff9a"], ink: "#3a1850", accent: "#e0a8ff" },
];

export interface SupporterRank {
  /* Index into SUPPORTER_RANKS. */
  index: number;
  def: SupporterRankDef;
  /* Whole months in a row so far, counting the one under way: 1 on the first day. */
  months: number;
  /* When the next rank is reached; null at the top. */
  nextAt: number | null;
}

/* The rank of a run that began at `runStartedAt`, as of `now`. */
export function supporterRank(runStartedAt: number, now = Date.now()): SupporterRank {
  const months = Math.max(0, Math.floor((now - runStartedAt) / SUPPORTER_RANK_MONTH_MS)) + 1;
  const index = Math.min(months, SUPPORTER_RANKS.length) - 1;
  const nextAt = index < SUPPORTER_RANKS.length - 1 ? runStartedAt + (index + 1) * SUPPORTER_RANK_MONTH_MS : null;
  return { index, def: SUPPORTER_RANKS[index], months, nextAt };
}
