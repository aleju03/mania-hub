// A supporter's rank: one step for every month in a row they have been a
// supporter, from Amber on their first day to Holo after eleven months, where
// it stays. Every rank is a gem, so even the first reads as a reward. A lapse
// ends the run, and the next one starts again at Amber.
//
// The backend sends only when the current run began (`runStartedAt`); the rank
// is worked out here, so a cached look keeps counting.


const DAY_MS = 24 * 60 * 60 * 1000;
/* A month of supporter time, the same 30 days $3 buys. */
export const SUPPORTER_RANK_MONTH_MS = 30 * DAY_MS;

export interface SupporterRankDef {
  id: string;
  /* Gem names stay in English in every language. */
  name: string;
  /* The badge's fill, light to dark across it. */
  stops: [string, string, string, string];
  /* The heart on it. */
  ink: string;
  /* The colour the rank's name is written in. */
  accent: string;
}

export const SUPPORTER_RANKS: readonly SupporterRankDef[] = [
  { id: "amber", name: "Amber", stops: ["#ffc48a", "#c8641e", "#f59a52", "#6e2e08"], ink: "#4a1c04", accent: "#f7a868" },
  { id: "topaz", name: "Topaz", stops: ["#f0c48a", "#a8702c", "#e3b070", "#6a4010"], ink: "#4a2a06", accent: "#e8b878" },
  { id: "moonstone", name: "Moonstone", stops: ["#e6edf2", "#6f7d8a", "#c9d3dc", "#3b444d"], ink: "#22292f", accent: "#b8c4cf" },
  { id: "pearl", name: "Pearl", stops: ["#ffffff", "#a3afbd", "#eef3f8", "#66717f"], ink: "#38414c", accent: "#e2e8ef" },
  { id: "obsidian", name: "Obsidian", stops: ["#6b5a8a", "#15121c", "#3a3150", "#050408"], ink: "#b9a8e0", accent: "#b9a8e0" },
  { id: "gold", name: "Gold", stops: ["#fff2b0", "#e0a21e", "#ffe07a", "#9a5d00"], ink: "#6b3c00", accent: "#ffd56b" },
  { id: "sapphire", name: "Sapphire", stops: ["#b8d4ff", "#2b56d6", "#7fa8ff", "#0f2580"], ink: "#0a1850", accent: "#8fb2ff" },
  { id: "ruby", name: "Ruby", stops: ["#ffb3c0", "#d1183f", "#ff6f8a", "#6e0019"], ink: "#4a0010", accent: "#ff6f8a" },
  { id: "emerald", name: "Emerald", stops: ["#b6ffd9", "#0aa66a", "#5cf0b0", "#00593a"], ink: "#003a24", accent: "#5cf0b0" },
  { id: "amethyst", name: "Amethyst", stops: ["#e7c8ff", "#8a3ad9", "#c48cff", "#3e0f75"], ink: "#2a0850", accent: "#c48cff" },
  { id: "diamond", name: "Diamond", stops: ["#ffffff", "#bfe9ff", "#ffffff", "#8fb8d6"], ink: "#2c4a63", accent: "#cdeeff" },
  { id: "holo", name: "Holo", stops: ["#ff8ad0", "#b48cff", "#7fe6ff", "#c6ff9a"], ink: "#3a1850", accent: "#e0a8ff" },
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
