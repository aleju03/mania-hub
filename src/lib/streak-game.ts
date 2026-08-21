import { msg } from "@lingui/core/macro";
import type { LiveGlobalRankingEntry } from "./live-backend";
import type { AppLocale } from "./locale";

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

/* How deep the game draws, in three steps. The top of the pool is the part the
   community can actually argue about, and how far down that goes is a matter
   of taste: 500 is the part most people could name, 1000 is the part somebody
   could. Past that a name means nothing and the read turns into a coin flip,
   which is exactly what the hard mode sells: "anyone" draws from the entire
   tracked snapshot, where the guess has to come off rank, country and instinct
   alone.

   "top" is the 1000 pool rather than the 500 one because it was the 1000 pool
   first, and best streaks stored under that name on someone's machine should
   keep meaning what they meant when they were earned. */
export type StreakPool = "top500" | "top" | "anyone";
export const STREAK_POOL_PLAYERS = 1000;
export const STREAK_POOL_PLAYERS_TIGHT = 500;
export const STREAK_PAGE_SIZE = 50;

/* How far down the rankings each pool reaches. Infinity is the whole tracked
   snapshot, clamped by what it actually holds wherever it is used. */
export function streakPoolDepth(pool: StreakPool): number {
  if (pool === "anyone") return Number.MAX_SAFE_INTEGER;
  return pool === "top500" ? STREAK_POOL_PLAYERS_TIGHT : STREAK_POOL_PLAYERS;
}

/* Kept close to the seen set: a run this long has emptied a page or two of the
   pool, and repeats read as the game running out rather than as a challenge. */
export const STREAK_REFILL_THRESHOLD = 12;

/* One best per pool: a 20-streak against the top 500 and a 20-streak against
   the whole snapshot are different achievements, and overwriting one with the
   other would erase whichever game someone is actually good at. */
export const STREAK_BEST_STORAGE_KEY = "mania-hub-streak-best-v1";
export const STREAK_BEST_ANYONE_STORAGE_KEY = "mania-hub-streak-best-anyone-v1";
export const STREAK_BEST_TOP500_STORAGE_KEY = "mania-hub-streak-best-top500-v1";

function bestStreakKey(pool: StreakPool): string {
  if (pool === "anyone") return STREAK_BEST_ANYONE_STORAGE_KEY;
  return pool === "top500" ? STREAK_BEST_TOP500_STORAGE_KEY : STREAK_BEST_STORAGE_KEY;
}

/* Mirrors the backend's milestone spacing so the board can say what the next
   one is worth while you are still playing for it. What a finished run
   actually pays is decided server-side and comes back with the claim; this is
   only ever the sign on the wall. */
export const STREAK_MILESTONE = 5;
export const STREAK_MILESTONE_BONUS = 10;
export const STREAK_SHARDS_PER_CORRECT = 8;

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

/* Every line of the game's copy is a whole sentence with named placeholders,
   never a prefix/middle/suffix the page glues back together: which end of the
   question a name belongs at is a fact about the language, not about the
   game, and a fragment table can only ever encode English's answer. The
   page resolves these through i18n._() and, for the question, fills {hidden}
   and {shown} with the two card-coloured name spans. */
type StreakMessage = ReturnType<typeof msg>;

export interface StreakMetricCopy {
  /* The question line. {hidden} is the card still hiding its number, {shown}
     the face-up one it is being compared against. */
  q: StreakMessage;
  /* What the two guess buttons say. */
  more: StreakMessage;
  less: StreakMessage;
  /* The text under a face-up card. */
  value: (value: number, locale?: AppLocale) => StreakMessage;
  /* The text under the card still hiding its number. */
  unknown: StreakMessage;
  /* The end-of-run reveal: what the card you lost to (or walked away from
     knowing) actually had. */
  reveal: (username: string, value: number, locale?: AppLocale) => StreakMessage;
}

/* Date metrics ride the same numeric machinery as counts: the value is epoch
   ms, so "more" means later. The UI locale is a catalog choice, so map it onto
   the Intl tag the month name should follow; the "en" default keeps every
   existing call site printing exactly what it printed before. */
const STREAK_MONTH_LOCALE: Record<AppLocale, string> = {
  en: "en-US",
  "zh-CN": "zh-CN",
  es: "es-419",
};

export function formatStreakMonth(ms: number, locale: AppLocale = "en"): string {
  return new Date(ms).toLocaleDateString(STREAK_MONTH_LOCALE[locale], {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

export const STREAK_METRIC_COPY: Record<StreakMetric, StreakMetricCopy> = {
  plays: {
    q: msg`Does {hidden} have more or fewer plays than {shown}?`,
    more: msg`More plays`,
    less: msg`Fewer plays`,
    value: (v) => {
      const plays = formatStreakValue(v, "plays");
      return msg`${plays} plays`;
    },
    unknown: msg`? plays`,
    reveal: (name, v) => {
      const plays = formatStreakValue(v, "plays");
      return msg`${name} had ${plays} plays.`;
    },
  },
  score: {
    q: msg`Does {hidden} have more or fewer ranked score than {shown}?`,
    more: msg`More score`,
    less: msg`Less score`,
    value: (v) => {
      const score = formatStreakValue(v, "score");
      return msg`${score} ranked score`;
    },
    unknown: msg`? ranked score`,
    reveal: (name, v) => {
      const score = formatStreakValue(v, "score");
      return msg`${name} had ${score} ranked score.`;
    },
  },
  oldestTop: {
    q: msg`Is {hidden}'s oldest top play older or newer than {shown}'s?`,
    more: msg`Newer`,
    less: msg`Older`,
    value: (v, locale) => {
      const month = formatStreakMonth(v, locale);
      return msg`oldest top ${month}`;
    },
    unknown: msg`oldest top ?`,
    reveal: (name, v, locale) => {
      const month = formatStreakMonth(v, locale);
      return msg`${name}'s oldest top play is from ${month}.`;
    },
  },
  dtTop: {
    q: msg`Does {hidden} have more or fewer DT top plays than {shown}?`,
    more: msg`More DT`,
    less: msg`Fewer DT`,
    value: (v) => {
      const count = Math.round(v).toLocaleString("en-US");
      return msg`${count} DT top plays`;
    },
    unknown: msg`? DT top plays`,
    reveal: (name, v) => {
      const count = Math.round(v).toLocaleString("en-US");
      return msg`${name} had ${count} DT top plays.`;
    },
  },
  k7Top: {
    q: msg`Does {hidden} have more or fewer 7K top plays than {shown}?`,
    more: msg`More 7K`,
    less: msg`Fewer 7K`,
    value: (v) => {
      const count = Math.round(v).toLocaleString("en-US");
      return msg`${count} 7K top plays`;
    },
    unknown: msg`? 7K top plays`,
    reveal: (name, v) => {
      const count = Math.round(v).toLocaleString("en-US");
      return msg`${name} had ${count} 7K top plays.`;
    },
  },
  playTime: {
    q: msg`Does {hidden} have more or less playtime than {shown}?`,
    more: msg`More playtime`,
    less: msg`Less playtime`,
    value: (v) => {
      const hours = Math.round(v).toLocaleString("en-US");
      return msg`${hours} hours`;
    },
    unknown: msg`? hours`,
    reveal: (name, v) => {
      const hours = Math.round(v).toLocaleString("en-US");
      return msg`${name} has ${hours} hours of playtime.`;
    },
  },
  joined: {
    q: msg`Did {hidden} join osu! earlier or later than {shown}?`,
    more: msg`Later`,
    less: msg`Earlier`,
    value: (v, locale) => {
      const month = formatStreakMonth(v, locale);
      return msg`joined ${month}`;
    },
    unknown: msg`joined ?`,
    reveal: (name, v, locale) => {
      const month = formatStreakMonth(v, locale);
      return msg`${name} joined in ${month}.`;
    },
  },
  followers: {
    q: msg`Does {hidden} have more or fewer followers than {shown}?`,
    more: msg`More followers`,
    less: msg`Fewer followers`,
    value: (v) => {
      const count = Math.round(v).toLocaleString("en-US");
      return msg`${count} followers`;
    },
    unknown: msg`? followers`,
    reveal: (name, v) => {
      const count = Math.round(v).toLocaleString("en-US");
      return msg`${name} has ${count} followers.`;
    },
  },
  replayViews: {
    q: msg`Have {hidden}'s replays been watched more or less than {shown}'s?`,
    more: msg`More watched`,
    less: msg`Less watched`,
    value: (v) => {
      const count = Math.round(v).toLocaleString("en-US");
      return msg`${count} replay views`;
    },
    unknown: msg`? replay views`,
    reveal: (name, v) => {
      const count = Math.round(v).toLocaleString("en-US");
      return msg`${name}'s replays have ${count} views.`;
    },
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
  const depth = Math.min(streakPoolDepth(pool), Math.max(0, Math.floor(total)));
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
   the pools (they come off the same rankings pagination), so a deep run's
   pages must not leak rank-8000 names into a top-500 draw. */
export function streakPoolEntries(
  entries: readonly LiveGlobalRankingEntry[],
  pool: StreakPool,
): readonly LiveGlobalRankingEntry[] {
  if (pool === "anyone") return entries;
  const depth = streakPoolDepth(pool);
  return entries.filter((entry) => entry.rank <= depth);
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
  if (metric === "plays") return Math.round(value).toLocaleString("en-US");
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  return Math.round(value).toLocaleString("en-US");
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
