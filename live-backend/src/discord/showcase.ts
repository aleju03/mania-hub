// Real-data backing for the /discord command showcase on the site.
//
// The showcase (src/components/discord/CommandShowcase.tsx) renders a faithful
// preview of every maniabot reply. It used to be filled with hardcoded mock
// content ("Blue Zenith" everywhere), which made it hard to judge the design
// against real data. This module assembles a real snapshot for a representative
// player / country / beatmap by calling the SAME feature functions the bot
// handlers use, formats it into presentation-ready primitives, and caches it so
// the page never has to recompute on every visit.
//
// Everything here is best-effort: each section is wrapped so a single failing
// read (a missing roster, an osu! API hiccup) degrades to null and the frontend
// falls back to its synthetic mock for just that command, never the whole page.

import type { Config } from "../config.js";
import type { Db } from "../db.js";
import type { JobQueue } from "../jobs/queue.js";
import type { OsuApiClient } from "../osu/client.js";
import { GLOBAL_COUNTRY_CODE, isGlobalCountry } from "../countries.js";
import { getDisplayedAccuracy, getDisplayedRank, getModAcronyms } from "../shared/score.js";
import type { CountryTopPlay, LeanTrackerScore, OscScore } from "../shared/types.js";
import { getPlayerProfileSnapshot, getPlayerRecentScores } from "../features/player-profiles.js";
import { getCountryRankingsSnapshot, getGlobalRankingsSnapshot } from "../features/global-rankings.js";
import { getTopPlaysSnapshot } from "../features/top-plays.js";
import { getTrackerSnapshot } from "../features/tracker.js";
import { getMapsRandomBeatmapsets, getMapsSnapshot } from "../features/maps.js";
import { getDanEstimateBatch } from "../features/dan-estimates.js";
import { getPlayerActivitySnapshot } from "../features/activity.js";
import { getMyDataSummary } from "../features/my-data.js";
import { logWarn } from "../logger.js";

// ---------------------------------------------------------------------------
// Payload shape (mirrored on the frontend in src/lib/live-backend.ts)
// ---------------------------------------------------------------------------

// One score line: grade icon, map title + difficulty, key mode, mods, acc, pp.
export interface ShowcaseScore {
  grade: string;
  title: string;
  version: string;
  keys: string;
  mods: string[];
  acc: string;
  pp: string;
  gain?: string;
}

export interface ShowcasePlayer {
  id: number;
  username: string;
  countryCode: string;
  globalRank: number | null;
  countryRank: number | null;
  pp: number | null;
  accuracy: number | null;
  playCount: number | null;
  level: number | null;
}

export interface ShowcaseRankRow {
  rank: number;
  username: string;
  userId: number;
  pp: string;
}

export interface ShowcaseTopRow {
  username: string;
  userId: number;
  title: string;
  mods: string[];
  pp: string;
  gain?: string;
}

export interface ShowcaseTrackerRow {
  grade: string;
  username: string;
  title: string;
  mods: string[];
  acc: string;
  pp: string;
}

export interface ShowcaseFarmedRow {
  rank: number;
  title: string;
  stars: string;
  avg: string;
  players: string;
}

export interface ShowcaseMe {
  globalRank: number | null;
  countryRank: number | null;
  countryCode: string;
  pp: number | null;
  activeDays: number;
  sessions: number;
  topPlayCount: number;
  biggestDay: string | null;
  longestStreak: string | null;
  ppGained: string | null;
  goalsLine: string;
}

export interface ShowcaseActivity {
  activeDays: number;
  totalPlays: number;
  sessions: number;
  playsPerSession: number;
  currentStreak: number;
  year: number;
  patterns: Array<{ label: string; pct: number }>;
}

export interface ShowcaseVsRow {
  label: string;
  a: string;
  b: string;
  aWins: boolean;
  bWins: boolean;
}

export interface ShowcaseBeatmap {
  title: string;
  stars: string;
  keys: string;
  status: string;
  bpm: string;
  length: string;
  dan: string;
  cover: string | null;
}

export interface ShowcaseRandomFarm {
  title: string;
  stars: string;
  keys: string;
  bpm: string;
  status: string;
  avgPp: string;
  maxPp: string;
  players: number;
  dominantMod: string | null;
  cover: string | null;
}

export interface ShowcaseRandomFav {
  title: string;
  stars: string;
  keys: string;
  status: string;
  bpm: string;
  globalFavs: string;
  patterns: string;
  pickedBy: string;
  others: number;
  cover: string | null;
}

export interface ShowcaseDiscordPayload {
  country: string;
  isGlobal: boolean;
  generatedAt: number;
  // A pool of distinct top players, one per player-centric command so the
  // previews don't all show the same person. The detail sections below are each
  // captured for a fixed index in this pool (see buildShowcase): topPlays ->
  // players[1], recent -> players[2], me -> players[0], activity -> players[4].
  // /goals (players[5]) and /farm (players[6]) only borrow an identity for
  // variety; their content is a fixed example on the frontend (top players
  // rarely have site goals / 4K farm recs, so fetching them is wasted).
  players: ShowcasePlayer[];
  topPlays: ShowcaseScore[];
  recent: ShowcaseScore[];
  pb: (ShowcaseScore & { mapTitle: string; combo: string }) | null;
  me: ShowcaseMe | null;
  activity: ShowcaseActivity | null;
  vs: { title: string; rows: ShowcaseVsRow[] } | null;
  rankings: ShowcaseRankRow[];
  topList: ShowcaseTopRow[];
  tracker: ShowcaseTrackerRow[];
  mapsFarmed: ShowcaseFarmedRow[];
  randomFarm: ShowcaseRandomFarm | null;
  randomFav: ShowcaseRandomFav | null;
  map: ShowcaseBeatmap | null;
  dan: { displayName: string; family: string; confidence: string; label: string; familyKey: string } | null;
  feedTopPlay: { username: string; userId: number; title: string; grade: string; mods: string[]; acc: string; pp: string; gain: string; cover: string | null } | null;
  feedNewMap: { title: string; keys: string; stars: string; cover: string | null } | null;
}

// ---------------------------------------------------------------------------
// Formatting helpers (mirror the embed builders so the preview reads as the bot)
// ---------------------------------------------------------------------------

const NUMBER = new Intl.NumberFormat("en-US");

// Player totals (rankings, /vs) carry thousand separators, matching the embeds'
// formatInt usage.
function fmtPp(pp: number | null | undefined): string {
  return pp == null || !(pp > 0) ? "-" : `${NUMBER.format(Math.round(pp))}pp`;
}

// A single play's / map's pp prints WITHOUT separators, matching the embeds'
// formatPp (e.g. "1234pp", not "1,234pp").
function fmtScorePp(pp: number | null | undefined): string {
  return pp == null || !(pp > 0) ? "-" : `${Math.round(pp)}pp`;
}

function fmtAcc(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "-";
  const pct = value <= 1 ? value * 100 : value;
  return `${pct.toFixed(2)}%`;
}

function fmtClock(totalSeconds: number | null | undefined): string {
  if (totalSeconds == null || !Number.isFinite(totalSeconds) || totalSeconds <= 0) return "-";
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.round(totalSeconds % 60);
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function titleCase(value: string): string {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

function keyLabel(cs: number | null | undefined): string {
  return cs == null || !Number.isFinite(cs) ? "" : `${Math.round(cs)}K`;
}

function bestCover(covers: Record<string, string | undefined> | undefined): string | null {
  if (!covers) return null;
  return covers["cover@2x"] ?? covers.cover ?? covers["card@2x"] ?? covers.card ?? covers.list ?? null;
}

const PATTERN_LABELS: Record<string, string> = {
  stream: "Stream", jumpstream: "Jumpstream", handstream: "Handstream", jacks: "Jacks",
  jack: "Jacks", chordjack: "Chordjack", chordjacks: "Chordjacks", stamina: "Stamina",
  tech: "Tech", technical: "Technical", speed: "Speed", ln: "LN", longnote: "LN",
  jumptrill: "Jumptrill", bracket: "Bracket", coordination: "Coordination", hybrid: "Hybrid",
};
function patternLabel(key: string): string {
  return PATTERN_LABELS[key.toLowerCase()] ?? titleCase(key);
}

function scoreTitle(score: OscScore): { title: string; version: string } {
  const set = score.beatmapset;
  const name = set ? `${set.artist} - ${set.title}` : `Beatmap ${score.beatmap_id ?? score.id}`;
  return { title: name, version: score.beatmap?.version ?? "" };
}

function toShowcaseScore(score: OscScore, gain?: number): ShowcaseScore {
  const { title, version } = scoreTitle(score);
  const out: ShowcaseScore = {
    grade: getDisplayedRank(score),
    title,
    version,
    keys: keyLabel(score.beatmap?.cs),
    mods: getModAcronyms(score.mods),
    acc: fmtAcc(getDisplayedAccuracy(score)),
    pp: fmtScorePp(score.pp),
  };
  if (gain != null && gain > 0) out.gain = `+${Math.round(gain)}pp`;
  return out;
}

interface ProfileUserShape {
  id?: number;
  username?: string;
  country_code?: string;
  statistics?: {
    global_rank?: number | null;
    country_rank?: number | null;
    pp?: number | null;
    hit_accuracy?: number | null;
    play_count?: number | null;
    level?: { current?: number | null } | null;
  } | null;
}

function toShowcasePlayer(user: Record<string, unknown>): ShowcasePlayer {
  const u = user as ProfileUserShape;
  const stats = u.statistics ?? {};
  return {
    id: Number(u.id ?? 0),
    username: String(u.username ?? "player"),
    countryCode: String(u.country_code ?? "").toUpperCase(),
    globalRank: stats.global_rank ?? null,
    countryRank: stats.country_rank ?? null,
    pp: stats.pp ?? null,
    accuracy: stats.hit_accuracy ?? null,
    playCount: stats.play_count ?? null,
    level: stats.level?.current == null ? null : Math.round(stats.level.current),
  };
}

// ---------------------------------------------------------------------------
// Player pool
// ---------------------------------------------------------------------------

interface RankingEntryLike {
  rank: number;
  user: { id: number; username: string; country_code?: string };
  pp: number;
  global_rank?: number | null;
  country_rank?: number | null;
  hit_accuracy?: number | null;
  play_count?: number | null;
}

function rankingEntryToPlayer(entry: RankingEntryLike): ShowcasePlayer {
  return {
    id: Number(entry.user.id),
    username: String(entry.user.username),
    countryCode: String(entry.user.country_code ?? "").toUpperCase(),
    globalRank: entry.global_rank ?? null,
    countryRank: entry.country_rank ?? null,
    pp: entry.pp ?? null,
    accuracy: entry.hit_accuracy ?? null,
    playCount: entry.play_count ?? null,
    level: null,
  };
}

// A distinct pool of top players (full stats) for the country/global board. The
// rankings snapshots carry per-player stats, so one query gives every player the
// previews need. These are public leaderboard figures, so nothing here exposes
// anything the public rankings/bot don't already show; the endpoint accepts no
// user id (no arbitrary-user lookups).
async function buildPlayerPool(db: Db, country: string, limit: number): Promise<ShowcasePlayer[]> {
  const snap = await safe("player_pool", () => (isGlobalCountry(country)
    ? getGlobalRankingsSnapshot(db, { page: 1, pageSize: limit, sort: "pp", dir: "desc" })
    : getCountryRankingsSnapshot(db, country, { page: 1, pageSize: limit })));
  return (snap?.ranking ?? [])
    .map((entry) => rankingEntryToPlayer(entry as RankingEntryLike))
    .filter((player) => player.id > 0);
}

// ---------------------------------------------------------------------------
// Server-side cache (compute once per country, reuse for an hour)
// ---------------------------------------------------------------------------

interface CacheEntry {
  storedAt: number;
  payload: Promise<ShowcaseDiscordPayload>;
}
const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 60 * 60_000;
const CACHE_MAX_ENTRIES = 24;

export function getDiscordShowcase(
  deps: { db: Db; osu: OsuApiClient; queue: JobQueue; config: Config },
  country: string,
  fresh: boolean,
): Promise<ShowcaseDiscordPayload> {
  const key = isGlobalCountry(country) ? GLOBAL_COUNTRY_CODE : country.toUpperCase();
  const now = Date.now();
  for (const [entryKey, entry] of cache) {
    if (now - entry.storedAt > CACHE_TTL_MS) cache.delete(entryKey);
  }
  while (cache.size > CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  const cached = cache.get(key);
  if (cached && !fresh) return cached.payload;
  const payload = buildShowcase(deps, key);
  cache.set(key, { storedAt: now, payload });
  payload.catch(() => {
    if (cache.get(key)?.payload === payload) cache.delete(key);
  });
  return payload;
}

// ---------------------------------------------------------------------------
// Assembler
// ---------------------------------------------------------------------------

const MAPS_MAX_AGE_MS = 24 * 60 * 60 * 1000;

async function safe<T>(label: string, fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (error) {
    logWarn("discord_showcase_section_failed", { section: label, error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

async function buildShowcase(
  deps: { db: Db; osu: OsuApiClient; queue: JobQueue; config: Config },
  country: string,
): Promise<ShowcaseDiscordPayload> {
  const { db, osu, queue } = deps;
  const isGlobal = isGlobalCountry(country);

  // A pool of distinct top players. Each player-centric command renders a
  // different one (with its own real detail), so the previews don't all show the
  // same person.
  const players = await buildPlayerPool(db, country, 8);
  const idAt = (i: number): number => players[i]?.id ?? 0;

  // players[1]: full profile -> top plays (and a richer stat block incl. level).
  const profile = idAt(1) ? await safe("profile", () => getPlayerProfileSnapshot(db, osu, String(idAt(1)))) : null;
  if (profile && players[1]) players[1] = toShowcasePlayer(profile.user);
  const topPlays: ShowcaseScore[] = (profile?.bestScores ?? []).slice(0, 5).map((s) => toShowcaseScore(s));

  // players[1]'s best play is, by definition, their personal best on its map, so
  // it doubles as a real /pb example.
  const bestScore = profile?.bestScores?.[0] ?? null;
  const pb = bestScore
    ? {
      ...toShowcaseScore(bestScore),
      mapTitle: `${scoreTitle(bestScore).title} [${scoreTitle(bestScore).version}]`,
      combo: bestScore.max_combo != null ? `${NUMBER.format(bestScore.max_combo)}x` : "-",
    }
    : null;

  // players[2]: recent plays.
  const recent: ShowcaseScore[] = idAt(2)
    ? (await safe("recent", async () => {
      const section = await getPlayerRecentScores(db, osu, idAt(2));
      return ((section.payload as OscScore[]) ?? []).slice(0, 5).map((s) => toShowcaseScore(s));
    })) ?? []
    : [];

  // /rankings reuses the same pool, so the board matches the players shown above.
  const rankings: ShowcaseRankRow[] = players.slice(0, 5).map((p, i): ShowcaseRankRow => ({
    rank: (isGlobal ? p.globalRank : p.countryRank) ?? i + 1,
    username: p.username,
    userId: p.id,
    pp: fmtPp(p.pp),
  }));

  const topPlaysSnapshot = await safe("top_plays", () => getTopPlaysSnapshot(db, country, "7d", { page: 1, pageSize: 10 }));
  const popoffs: CountryTopPlay[] = topPlaysSnapshot?.popoffs ?? [];
  const topList: ShowcaseTopRow[] = popoffs.slice(0, 3).map((p): ShowcaseTopRow => {
    const { title } = scoreTitle(p.score);
    return {
      username: p.user.username,
      userId: Number(p.user.id),
      title,
      mods: getModAcronyms(p.score.mods),
      pp: fmtScorePp(p.score.pp),
      gain: p.ppGain > 0 ? `+${Math.round(p.ppGain)}` : undefined,
    };
  });

  const trackerSnapshot = await safe("tracker", () => getTrackerSnapshot(db, country, 12, 0, { sort: "recent", sortDirection: "desc" }));
  const tracker: ShowcaseTrackerRow[] = (trackerSnapshot?.scores ?? []).slice(0, 4).map((s: LeanTrackerScore): ShowcaseTrackerRow => {
    const set = s.beatmapset;
    return {
      grade: getDisplayedRank(s),
      username: s.user?.username ?? "?",
      title: set ? `${set.artist} - ${set.title}` : `Beatmap ${s.beatmap_id ?? s.id}`,
      mods: getModAcronyms(s.mods),
      acc: fmtAcc(getDisplayedAccuracy(s)),
      pp: fmtScorePp(s.pp),
    };
  });

  const mapsSnapshot = await safe("maps", () => getMapsSnapshot(db, queue, country, MAPS_MAX_AGE_MS, "core"));
  const farmed = mapsSnapshot?.value?.farmed ?? [];
  const mapsFarmed: ShowcaseFarmedRow[] = farmed.slice(0, 3).map((m, i): ShowcaseFarmedRow => ({
    rank: i + 1,
    title: `${m.artist} - ${m.title} [${m.version}]`,
    stars: m.difficultyRating != null ? m.difficultyRating.toFixed(2) : "-",
    avg: fmtScorePp(m.avgPp),
    players: NUMBER.format(m.playerCount),
  }));

  // A representative beatmap for /map, /dan, /randomfarm: prefer a 4K farmed map
  // so the dan estimate (ranked 4K only) actually resolves.
  const focusFarmed = farmed.find((m) => Math.round(m.cs) === 4) ?? farmed[0] ?? null;

  const randomFarm: ShowcaseRandomFarm | null = focusFarmed
    ? {
      title: `${focusFarmed.artist} - ${focusFarmed.title} [${focusFarmed.version}]`,
      stars: focusFarmed.difficultyRating != null ? focusFarmed.difficultyRating.toFixed(2) : "-",
      keys: keyLabel(focusFarmed.cs),
      bpm: focusFarmed.bpm != null ? NUMBER.format(Math.round(focusFarmed.bpm)) : "-",
      status: focusFarmed.status ? titleCase(focusFarmed.status) : "-",
      avgPp: fmtScorePp(focusFarmed.avgPp),
      maxPp: fmtScorePp(focusFarmed.maxPp),
      players: focusFarmed.playerCount,
      dominantMod: focusFarmed.dominantMod ?? null,
      cover: bestCover(focusFarmed.covers),
    }
    : null;

  const feedTopPlay = popoffs[0]
    ? (() => {
      const ev = popoffs[0];
      const { title, version } = scoreTitle(ev.score);
      return {
        username: ev.user.username,
        userId: Number(ev.user.id),
        title: version ? `${title} [${version}]` : title,
        grade: getDisplayedRank(ev.score),
        mods: getModAcronyms(ev.score.mods),
        acc: fmtAcc(getDisplayedAccuracy(ev.score)),
        pp: fmtScorePp(ev.score.pp),
        gain: ev.ppGain > 0 ? `+${Math.round(ev.ppGain)}pp` : "",
        cover: bestCover(ev.score.beatmapset?.covers),
      };
    })()
    : null;

  const feedNewMap = focusFarmed
    ? {
      title: `${focusFarmed.artist} - ${focusFarmed.title} [${focusFarmed.version}]`,
      keys: keyLabel(focusFarmed.cs),
      stars: focusFarmed.difficultyRating != null ? focusFarmed.difficultyRating.toFixed(2) : "-",
      cover: bestCover(focusFarmed.covers),
    }
    : null;

  // /map + /dan for the focus beatmap.
  let map: ShowcaseBeatmap | null = null;
  let dan: ShowcaseDiscordPayload["dan"] = null;
  if (focusFarmed) {
    // computeMissing:false so a cold estimate is queued, not computed inline:
    // the showcase must not make blocking osu! API calls inside the request. A
    // popular farmed map is almost always already cached; a miss just falls back
    // to the synthetic dan until the next capture.
    const danBatch = await safe("dan", () => getDanEstimateBatch(db, queue, osu, [{ beatmapId: focusFarmed.beatmapId, rate: 1 }], { computeMissing: false }));
    const estimate = danBatch?.results?.[String(focusFarmed.beatmapId)] ?? null;
    if (estimate) {
      dan = {
        displayName: estimate.displayName ?? estimate.label ?? "Unknown",
        family: estimate.family ? titleCase(estimate.family) : "-",
        confidence: estimate.confidence != null ? `${Math.round(estimate.confidence * 100)}%` : "-",
        label: estimate.label ?? "",
        familyKey: (estimate.family ?? "").toLowerCase(),
      };
    }
    map = {
      title: `${focusFarmed.artist} - ${focusFarmed.title} [${focusFarmed.version}]`,
      stars: focusFarmed.difficultyRating != null ? `${focusFarmed.difficultyRating.toFixed(2)}` : "-",
      keys: keyLabel(focusFarmed.cs),
      status: focusFarmed.status ? titleCase(focusFarmed.status) : "-",
      bpm: focusFarmed.bpm != null ? NUMBER.format(Math.round(focusFarmed.bpm)) : "-",
      length: fmtClock(focusFarmed.totalLength),
      dan: dan?.displayName ?? "-",
      cover: bestCover(focusFarmed.covers),
    };
  }

  // /randomfav from the favourites pool (a real favourited set + who favourited it).
  const randomFav = await safe("random_fav", async () => buildRandomFav(db, queue, country));

  // Detail for distinct players so each command shows a different person:
  // /me -> players[0], /activity -> players[4]. (/goals and /farm use a fixed
  // example on the frontend, so they're not fetched here.)
  const me = idAt(0) ? await safe("me", () => buildMe(db, idAt(0))) : null;
  const activity = idAt(4)
    ? await safe("activity", () => buildActivity(db, queue, idAt(4), players[4]?.countryCode || country))
    : null;

  // /vs compares players[0] and players[1].
  const vs = players[0] && players[1] ? buildVs(players[0], players[1]) : null;

  return {
    country,
    isGlobal,
    generatedAt: Date.now(),
    players,
    topPlays,
    recent,
    pb,
    me,
    activity,
    vs,
    rankings,
    topList,
    tracker,
    mapsFarmed,
    randomFarm,
    randomFav,
    map,
    dan,
    feedTopPlay,
    feedNewMap,
  };
}

async function buildMe(db: Db, userId: number): Promise<ShowcaseMe> {
  const summary = await getMyDataSummary(db, userId);
  return {
    globalRank: summary.globalRank,
    countryRank: summary.countryRank,
    countryCode: (summary.countryCode ?? "").toUpperCase(),
    pp: summary.pp,
    activeDays: summary.activeDays,
    sessions: summary.sessions,
    topPlayCount: summary.topPlayCount,
    biggestDay: summary.highlights.biggestDay && summary.highlights.biggestDay.count > 0
      ? `${NUMBER.format(summary.highlights.biggestDay.count)} plays`
      : null,
    longestStreak: summary.highlights.longestStreak > 0
      ? `${summary.highlights.longestStreak} day${summary.highlights.longestStreak === 1 ? "" : "s"}`
      : null,
    ppGained: summary.highlights.ppGainedTracked > 0 ? `+${NUMBER.format(summary.highlights.ppGainedTracked)}` : null,
    goalsLine: `${summary.goalsOpen} open, ${summary.goalsCompleted} done`,
  };
}

async function buildActivity(db: Db, queue: JobQueue, userId: number, country: string): Promise<ShowcaseActivity | null> {
  const year = new Date().getUTCFullYear();
  const snapshot = await getPlayerActivitySnapshot(db, queue, userId, country, year);
  if (!snapshot.available) return null;
  const totals = new Map<string, number>();
  for (const day of snapshot.days) {
    const patterns = day.skills?.patterns;
    if (!patterns) continue;
    for (const [key, weight] of Object.entries(patterns)) {
      if (!Number.isFinite(weight) || weight <= 0) continue;
      totals.set(key, (totals.get(key) ?? 0) + weight);
    }
  }
  const sum = [...totals.values()].reduce((a, b) => a + b, 0);
  const patterns = sum > 0
    ? [...totals.entries()]
      .map(([key, weight]) => ({ label: patternLabel(key), pct: Math.round((weight / sum) * 100) }))
      .filter((p) => p.pct > 0)
      .sort((a, b) => b.pct - a.pct)
      .slice(0, 4)
    : [];
  return {
    activeDays: snapshot.activeDays,
    totalPlays: snapshot.totalScores,
    sessions: snapshot.totalSessions,
    playsPerSession: snapshot.typicalSession,
    currentStreak: snapshot.currentStreak,
    year: snapshot.year,
    patterns,
  };
}

function buildVs(a: ShowcasePlayer, b: ShowcasePlayer): { title: string; rows: ShowcaseVsRow[] } {
  const row = (label: string, av: number | null, bv: number | null, fmt: (n: number | null) => string, lowerWins = false): ShowcaseVsRow => {
    let aWins = false;
    let bWins = false;
    if (av != null && bv != null && av !== bv) {
      const aBeats = lowerWins ? av < bv : av > bv;
      aWins = aBeats;
      bWins = !aBeats;
    }
    return { label, a: fmt(av), b: fmt(bv), aWins, bWins };
  };
  return {
    title: `${a.username} vs ${b.username}`,
    rows: [
      row("pp", a.pp, b.pp, fmtPp),
      row("Global rank", a.globalRank, b.globalRank, (n) => (n == null ? "-" : `#${NUMBER.format(n)}`), true),
      row("Country rank", a.countryRank, b.countryRank, (n) => (n == null ? "-" : `#${NUMBER.format(n)}`), true),
      row("Accuracy", a.accuracy, b.accuracy, fmtAcc),
    ],
  };
}

// Sample one favourited set from the random pool, plus who favourited it, in the
// same uniform-over-(player, set) way the /randomfav handler does.
async function buildRandomFav(db: Db, queue: JobQueue, country: string): Promise<ShowcaseRandomFav | null> {
  const snapshot = await getMapsSnapshot(db, queue, country, MAPS_MAX_AGE_MS, "random");
  const data = snapshot.value;
  if (!data?.favouritesByPlayer?.length || !data.beatmapsetsPool) return null;
  // Count favourites per set (GLOBAL ships tens of thousands of rows, so tally
  // counts directly rather than materialising one row per (player, set)).
  const favCounts = new Map<number, number>();
  const firstFavBy = new Map<number, string>();
  for (const playerFavs of data.favouritesByPlayer) {
    for (const setId of playerFavs.beatmapsetIds) {
      if (!data.beatmapsetsPool[setId]) continue;
      favCounts.set(setId, (favCounts.get(setId) ?? 0) + 1);
      if (!firstFavBy.has(setId)) firstFavBy.set(setId, playerFavs.username);
    }
  }
  if (favCounts.size === 0) return null;
  // Deterministic pick (the most-favourited set in scope) so the cached preview
  // is stable; the real command rerolls but the showcase wants a steady example.
  let pickSetId = -1;
  let bestCount = 0;
  for (const [setId, count] of favCounts) {
    if (count > bestCount) {
      bestCount = count;
      pickSetId = setId;
    }
  }
  // The random pool ships lean (no covers/patterns); fetch the full set for art
  // and pattern tags, exactly like the /randomfav handler, falling back to lean.
  const lean = data.beatmapsetsPool[pickSetId];
  const set = (await getMapsRandomBeatmapsets(db, [pickSetId]).catch(() => []))[0] ?? lean;
  if (!set) return null;
  const keys = [...new Set((set.maniaKeys ?? []).map((k) => `${Math.round(k)}K`))];
  const patterns = (set.patterns ?? []).slice(0, 4).map(patternLabel);
  const lo = set.starMin;
  const hi = set.starMax;
  const stars = lo != null && hi != null && Math.abs(lo - hi) > 0.01
    ? `${lo.toFixed(2)}-${hi.toFixed(2)}`
    : `${(hi ?? lo ?? 0).toFixed(2)}`;
  return {
    title: `${set.artist} - ${set.title}`,
    stars,
    keys: keys.length ? keys.join(" ") : "-",
    status: set.status ? titleCase(set.status) : "-",
    bpm: set.bpm != null ? NUMBER.format(Math.round(set.bpm)) : "-",
    globalFavs: NUMBER.format(set.globalFavouriteCount ?? 0),
    patterns: patterns.length ? patterns.join(", ") : "-",
    pickedBy: firstFavBy.get(pickSetId) ?? "a player",
    others: Math.max(0, bestCount - 1),
    cover: bestCover(set.covers),
  };
}
