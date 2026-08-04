import type { LiveGlobalRankingEntry } from "./live-backend";

// Higher or lower, played with maniacards. Everything here is pure so the
// draw, the question and the scoring can be tested without a backend; the page
// owns the fetching, the minting and the animation.
//
// What the game does NOT ask is who has more pp. This is a community that
// knows its own leaderboard: show them DellyK and they already know he is
// above almost anyone, and a card front prints a tier that tracks pp closely
// enough to answer the question by itself. So the guesses are about numbers
// nobody memorises - play counts, ranked score, playtime, join dates, how
// many DT or 7K plays sit in a player's tops - which decouple from rank (the
// #3 player has 12k plays, the #4 has 112k) and are printed nowhere on the
// card. Rank and pp are shown on both cards on purpose: knowing exactly who
// you are looking at is what makes the guess a read rather than a coin flip.
//
// The game costs nothing to run: players come off the tracked global rankings
// snapshot the packs pool already reads, their cards are minted from plays
// the backend has stored, and the extra question numbers are one batched
// projection read per page of the pool, so a long run is a handful of cached
// reads and never an osu! API call.

/* How deep the game draws. The top of the pool is the part the community can
   actually argue about; too deep and a name means nothing and the read
   turns into a coin flip. Which is exactly what the hard mode sells: "anyone"
   draws from the entire tracked snapshot, where most names mean nothing and
   the guess has to come off rank, country and instinct alone. */
export type StreakPool = "top" | "anyone";
export const STREAK_POOL_PLAYERS = 1000;
export const STREAK_PAGE_SIZE = 50;

/* Kept close to the seen set: a run this long has emptied a page or two of the
   pool, and repeats read as the game running out rather than as a challenge. */
export const STREAK_REFILL_THRESHOLD = 12;

/* One best per pool: a 20-streak against the top 1000 and a 20-streak against
   the whole snapshot are different achievements, and overwriting one with the
   other would erase whichever game someone is actually good at. */
export const STREAK_BEST_STORAGE_KEY = "mania-hub-streak-best-v1";
export const STREAK_BEST_ANYONE_STORAGE_KEY = "mania-hub-streak-best-anyone-v1";

function bestStreakKey(pool: StreakPool): string {
  return pool === "anyone" ? STREAK_BEST_ANYONE_STORAGE_KEY : STREAK_BEST_STORAGE_KEY;
}

/* Mirrors the backend's milestone spacing so the board can say what the next
   one is worth while you are still playing for it. What a finished run
   actually pays is decided server-side and comes back with the claim; this is
   only ever the sign on the wall. */
export const STREAK_MILESTONE = 5;
export const STREAK_MILESTONE_BONUS = 5;
export const STREAK_SHARDS_PER_CORRECT = 5;

export function nextStreakMilestone(streak: number): { at: number; bonus: number } {
  const passed = Math.floor(Math.max(0, streak) / STREAK_MILESTONE);
  return { at: (passed + 1) * STREAK_MILESTONE, bonus: STREAK_MILESTONE_BONUS * (passed + 1) };
}

/* What a run is worth, mirrored from the backend so the cash-out button can
   name a number instead of asking you to press it and find out. The server
   still decides what actually lands (the day's allowance can trim it), which
   is why the summary prints what came back rather than this. */
export function streakShardValue(streak: number): number {
  const correct = Math.floor(Math.max(0, streak));
  const milestones = Math.floor(correct / STREAK_MILESTONE);
  return correct * STREAK_SHARDS_PER_CORRECT + (STREAK_MILESTONE_BONUS * milestones * (milestones + 1)) / 2;
}

export type StreakGuess = "more" | "less";

/* The questions a round can ask. All of them are wide-range, invisible on a
   card front, and not something anyone can recall for a player they know by
   name. Plays and ranked score come off the rankings snapshot; the rest come
   off the backend's stored projections (top plays and cached profiles) via
   one cheap batched read per page, and a player those projections do not
   cover simply is not asked that question. */
export type StreakMetric =
  | "plays"
  | "score"
  | "oldestTop"
  | "dtTop"
  | "k7Top"
  | "playTime"
  | "joined"
  | "followers"
  | "replayViews";
export const STREAK_METRICS = [
  "plays",
  "score",
  "oldestTop",
  "dtTop",
  "k7Top",
  "playTime",
  "joined",
  "followers",
  "replayViews",
] as const;

export interface StreakMetricCopy {
  /* The question line, assembled around the two card-coloured names:
     {prefix}<hidden card's name>{middle}<face-up card's name>{suffix}. */
  q: { prefix: string; middle: string; suffix: string };
  more: string;
  less: string;
  /* The text under a face-up card. */
  value: (value: number) => string;
  /* The text under the card still hiding its number. */
  unknown: string;
  /* The end-of-run reveal: what the card you lost to (or walked away from
     knowing) actually had. */
  reveal: (username: string, value: number) => string;
}

/* Date metrics ride the same numeric machinery as counts: the value is epoch
   ms, so "more" means later. Fixed to English because the surrounding copy
   is. */
export function formatStreakMonth(ms: number): string {
  return new Date(ms).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
}

export const STREAK_METRIC_COPY: Record<StreakMetric, StreakMetricCopy> = {
  plays: {
    q: { prefix: "Does ", middle: " have more or fewer plays than ", suffix: "?" },
    more: "More plays",
    less: "Fewer plays",
    value: (v) => `${formatStreakValue(v, "plays")} plays`,
    unknown: "? plays",
    reveal: (name, v) => `${name} had ${formatStreakValue(v, "plays")} plays.`,
  },
  score: {
    q: { prefix: "Does ", middle: " have more or fewer ranked score than ", suffix: "?" },
    more: "More score",
    less: "Less score",
    value: (v) => `${formatStreakValue(v, "score")} ranked score`,
    unknown: "? ranked score",
    reveal: (name, v) => `${name} had ${formatStreakValue(v, "score")} ranked score.`,
  },
  oldestTop: {
    q: { prefix: "Is ", middle: "'s oldest top play older or newer than ", suffix: "'s?" },
    more: "Newer",
    less: "Older",
    value: (v) => `oldest top ${formatStreakMonth(v)}`,
    unknown: "oldest top ?",
    reveal: (name, v) => `${name}'s oldest top play is from ${formatStreakMonth(v)}.`,
  },
  dtTop: {
    q: { prefix: "Does ", middle: " have more or fewer DT top plays than ", suffix: "?" },
    more: "More DT",
    less: "Fewer DT",
    value: (v) => `${Math.round(v).toLocaleString()} DT top plays`,
    unknown: "? DT top plays",
    reveal: (name, v) => `${name} had ${Math.round(v).toLocaleString()} DT top plays.`,
  },
  k7Top: {
    q: { prefix: "Does ", middle: " have more or fewer 7K top plays than ", suffix: "?" },
    more: "More 7K",
    less: "Fewer 7K",
    value: (v) => `${Math.round(v).toLocaleString()} 7K top plays`,
    unknown: "? 7K top plays",
    reveal: (name, v) => `${name} had ${Math.round(v).toLocaleString()} 7K top plays.`,
  },
  playTime: {
    q: { prefix: "Does ", middle: " have more or less playtime than ", suffix: "?" },
    more: "More playtime",
    less: "Less playtime",
    value: (v) => `${Math.round(v).toLocaleString()} hours`,
    unknown: "? hours",
    reveal: (name, v) => `${name} has ${Math.round(v).toLocaleString()} hours of playtime.`,
  },
  joined: {
    q: { prefix: "Did ", middle: " join osu! earlier or later than ", suffix: "?" },
    more: "Later",
    less: "Earlier",
    value: (v) => `joined ${formatStreakMonth(v)}`,
    unknown: "joined ?",
    reveal: (name, v) => `${name} joined in ${formatStreakMonth(v)}.`,
  },
  followers: {
    q: { prefix: "Does ", middle: " have more or fewer followers than ", suffix: "?" },
    more: "More followers",
    less: "Fewer followers",
    value: (v) => `${Math.round(v).toLocaleString()} followers`,
    unknown: "? followers",
    reveal: (name, v) => `${name} has ${Math.round(v).toLocaleString()} followers.`,
  },
  replayViews: {
    q: { prefix: "Have ", middle: "'s replays been watched more or less than ", suffix: "'s?" },
    more: "More watched",
    less: "Less watched",
    value: (v) => `${Math.round(v).toLocaleString()} replay views`,
    unknown: "? replay views",
    reveal: (name, v) => `${name}'s replays have ${Math.round(v).toLocaleString()} views.`,
  },
};

/* What the backend's projections know about a player beyond the rankings
   snapshot. Mirrors /api/packs/streak-metrics; every field nullable, and a
   null takes that question off the table for rounds this player is in. */
export interface StreakPlayerExtras {
  oldestTopAt: number | null;
  dtTop: number | null;
  k7Top: number | null;
  playTimeHours: number | null;
  joinedAt: number | null;
  followers: number | null;
  replayViews: number | null;
}

export interface StreakPlayer extends StreakPlayerExtras {
  userId: number;
  username: string;
  countryCode: string;
  avatarUrl: string;
  globalRank: number;
  pp: number;
  /* Null when the snapshot never stored one, which takes the player out of
     the draw for that metric rather than out of the game. */
  plays: number | null;
  score: number | null;
}

export function toStreakPlayer(entry: LiveGlobalRankingEntry, extras?: StreakPlayerExtras | null): StreakPlayer {
  const positive = (value: number | null | undefined): number | null =>
    typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
  /* Zero is a real answer for the count metrics (plenty of top-1000 players
     have no DT or no 7K in their tops); only the "when" and "how hard"
     numbers need to be positive to mean anything. */
  const count = (value: number | null | undefined): number | null =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
  return {
    userId: entry.user.id,
    username: entry.user.username,
    countryCode: entry.user.country_code,
    avatarUrl: entry.user.avatar_url,
    // Tracked players carry their osu! global rank; the pool position stands
    // in for anyone missing one, the same way the pack draw handles it.
    globalRank: entry.global_rank ?? entry.rank,
    pp: entry.pp,
    plays: positive(entry.play_count),
    score: positive(entry.ranked_score),
    oldestTopAt: positive(extras?.oldestTopAt),
    dtTop: count(extras?.dtTop),
    k7Top: count(extras?.k7Top),
    playTimeHours: positive(extras?.playTimeHours),
    joinedAt: positive(extras?.joinedAt),
    followers: count(extras?.followers),
    replayViews: count(extras?.replayViews),
  };
}

export function streakMetricValue(player: StreakPlayer, metric: StreakMetric): number | null {
  switch (metric) {
    case "plays": return player.plays;
    case "score": return player.score;
    case "oldestTop": return player.oldestTopAt;
    case "dtTop": return player.dtTop;
    case "k7Top": return player.k7Top;
    case "playTime": return player.playTimeHours;
    case "joined": return player.joinedAt;
    case "followers": return player.followers;
    case "replayViews": return player.replayViews;
  }
}

/* The pages the game may draw from: as much of the pool as the mode's depth
   allows, and never more than the snapshot actually holds. */
export function streakPageCount(total: number, pool: StreakPool = "top"): number {
  const depth = Math.min(
    pool === "anyone" ? Number.MAX_SAFE_INTEGER : STREAK_POOL_PLAYERS,
    Math.max(0, Math.floor(total)),
  );
  return Math.max(1, Math.ceil(depth / STREAK_PAGE_SIZE));
}

/* A page nobody has loaded yet, or null once they all are. Random rather than
   sequential so two runs in a row do not open on the same fifty players. */
export function pickUnloadedPage(
  total: number,
  loaded: ReadonlySet<number>,
  rng: () => number,
  pool: StreakPool = "top",
): number | null {
  const pages: number[] = [];
  for (let page = 1; page <= streakPageCount(total, pool); page += 1) {
    if (!loaded.has(page)) pages.push(page);
  }
  if (pages.length === 0) return null;
  return pages[Math.min(pages.length - 1, Math.floor(rng() * pages.length))];
}

/* Where the hard mode aims its next draw: the page holding a uniformly random
   pool position, so a rank-9000 nobody and a rank-12 name are equally likely.
   Drawing from whatever pages happen to be loaded would quietly favour the
   top, since those pages load first. */
export function streakRankPage(rank: number): number {
  return Math.max(1, Math.ceil(rank / STREAK_PAGE_SIZE));
}

/* Just that page's entries, so a pick aimed at it stays uniform instead of
   being diluted by everyone loaded before. */
export function streakPageSlice(
  entries: readonly LiveGlobalRankingEntry[],
  page: number,
): readonly LiveGlobalRankingEntry[] {
  const first = (page - 1) * STREAK_PAGE_SIZE + 1;
  const last = page * STREAK_PAGE_SIZE;
  return entries.filter((entry) => entry.rank >= first && entry.rank <= last);
}

/* The loaded entries a mode is allowed to draw from. Pages are shared between
   the two games (they come off the same rankings pagination), so a hard run's
   deep pages must not leak rank-8000 names into a top-1000 draw. */
export function streakPoolEntries(
  entries: readonly LiveGlobalRankingEntry[],
  pool: StreakPool,
): readonly LiveGlobalRankingEntry[] {
  if (pool === "anyone") return entries;
  return entries.filter((entry) => entry.rank <= STREAK_POOL_PLAYERS);
}

/* The next player to put on the board: anyone loaded who has not appeared in
   this run yet and who has a number for the metric being asked about. Null
   means the loaded pages are used up and the caller should pull another one in
   (or, once there are none left, start letting players repeat). */
export function pickStreakPlayer(
  entries: readonly LiveGlobalRankingEntry[],
  seen: ReadonlySet<number>,
  rng: () => number,
  metric?: StreakMetric,
  extras?: ReadonlyMap<number, StreakPlayerExtras>,
): StreakPlayer | null {
  const candidates = entries
    .filter((entry) => !seen.has(entry.user.id))
    .map((entry) => toStreakPlayer(entry, extras?.get(entry.user.id)))
    .filter((player) => (metric ? streakMetricValue(player, metric) !== null : playableMetrics(player).length > 0));
  if (candidates.length === 0) return null;
  return candidates[Math.min(candidates.length - 1, Math.floor(rng() * candidates.length))];
}

/* Which questions this player can be asked about at all. */
export function playableMetrics(player: StreakPlayer): StreakMetric[] {
  return STREAK_METRICS.filter((metric) => streakMetricValue(player, metric) !== null);
}

/* The question for a round, drawn from what both cards can answer. Rotating it
   is what keeps consecutive rounds from feeling like the same guess twice, and
   what stops a run being decided by whether you happen to know one number. */
export function pickStreakMetric(
  left: StreakPlayer,
  right: StreakPlayer,
  rng: () => number,
): StreakMetric | null {
  const shared = playableMetrics(left).filter((metric) => streakMetricValue(right, metric) !== null);
  if (shared.length === 0) return null;
  /* A dead-even pair (two 4K players with zero 7K tops each) is scored as a
     free point, which makes it a boring question. Ask something they differ
     on when anything qualifies. */
  const differing = shared.filter((metric) => streakMetricValue(left, metric) !== streakMetricValue(right, metric));
  const pool = differing.length > 0 ? differing : shared;
  return pool[Math.min(pool.length - 1, Math.floor(rng() * pool.length))];
}

/* Two players cannot realistically tie on a play count, but if the snapshot
   ever hands the game one, the guess stands: nobody should lose a streak to a
   coincidence. */
export function isStreakGuessCorrect(guess: StreakGuess, currentValue: number, nextValue: number): boolean {
  if (nextValue === currentValue) return true;
  return guess === "more" ? nextValue > currentValue : nextValue < currentValue;
}

/* Play counts read plainly, ranked scores do not: nine digits of score is a
   number nobody can compare at a glance. */
export function formatStreakValue(value: number, metric: StreakMetric): string {
  if (metric === "plays") return Math.round(value).toLocaleString();
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  return Math.round(value).toLocaleString();
}

export function readBestStreak(pool: StreakPool = "top"): number {
  if (typeof window === "undefined") return 0;
  try {
    const stored = Number(window.localStorage.getItem(bestStreakKey(pool)));
    return Number.isFinite(stored) && stored > 0 ? Math.floor(stored) : 0;
  } catch {
    return 0;
  }
}

export function writeBestStreak(streak: number, pool: StreakPool = "top"): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(bestStreakKey(pool), String(Math.max(0, Math.floor(streak))));
  } catch {
    // A best streak is bragging rights on one device; a full quota is not
    // worth interrupting the game for.
  }
}
