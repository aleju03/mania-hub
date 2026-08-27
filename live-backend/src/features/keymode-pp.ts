/**
 * Per-keymode pp plays this site tracked below a profile's osu! top-200 window.
 *
 * osu! serves at most 200 best scores, and a profile's keymode totals are built
 * from that window, so a keymode played on the side has most of its plays
 * invisible: 4K sat ~540pp under the figure osu! publishes, and 6K (11 plays in
 * the window) sat thousands under whatever the truth is.
 *
 * `player_activity_maps` is the fix. It keeps the best pp per (user, day, map)
 * for every score the ingest ever saw, with a retention measured in years, so
 * it holds plays that were never in the window and never will be. Folding it
 * into the window lets each keymode carry its own list of up to 200 plays
 * instead of sharing one 200-play budget with every other keymode.
 *
 * Two things this deliberately does not do:
 * - No converts. osu! grows its keymode statistics from natively-mania maps
 *   only, and both key-count sources here are mania-only tables, so a convert
 *   has no row to join and drops out on its own.
 * - No guessing at a key count. A map neither source knows is skipped rather
 *   than bucketed somewhere, which keeps every total a floor.
 */
import { exec, parseJson, type Db } from "../db.js";
import { getModAcronyms, nowIso } from "../shared/score.js";
import type { OsuMod, OsuScoreStatistics } from "../shared/types.js";

/** One tracked play, resolved to its keymode and carrying enough to list it
    beside the osu! window's own plays on the Best Performance tab. */
export interface KeymodePpPlay {
  beatmapId: number;
  keyCount: number;
  pp: number;
  /** Display metadata, null when no mania source stored the map's set. */
  beatmapsetId: number | null;
  title: string | null;
  artist: string | null;
  version: string | null;
  accuracy: number | null;
  rank: string | null;
  mods: string[];
  /** When the play that won this map happened, as an ISO instant. Rows from
      before that was recorded fall back to the day's last attempt, which is
      the same instant unless the map was replayed after the best play. */
  playedAt: string | null;
  /* Null for anything ingested before the day-best rows started keeping them,
     since the raw score payload they would have come from is pruned after 14
     days. A row reads them as unknown rather than as zero. */
  maxCombo: number | null;
  hasReplay: boolean | null;
  /** The solo score id /replay resolves, when the play kept one. */
  soloScoreId: number | null;
  /** Total score as the site displays it, or null for a row from before it
      was kept. */
  totalScore: number | null;
  /** Set when the play also has a legacy id, which is what makes it a stable
      score rather than a lazer one. */
  legacyScoreId: number | null;
  /** Judgement counts, so a tracked play can open the same details card a
      window play does. Null for a row stored before they were kept. */
  statistics: OsuScoreStatistics | null;
  creator: string | null;
  /** The map's own numbers at 1.0x. A reader showing them beside a rate-modded
      play has to say so or leave them out; they are not the play's. */
  stars: number | null;
  bpm: number | null;
}

export interface KeymodePpTail {
  userId: number;
  /** Whether the ingest has ever recorded a pp play for this user. */
  tracked: boolean;
  /** Earliest day the tail covers, as YYYY-MM-DD. Null when nothing is tracked. */
  trackedFrom: string | null;
  /** Plays with a known keymode, best-per-map, capped per keymode. */
  plays: KeymodePpPlay[];
  /** Rows dropped because no mania source carries the map's key count. */
  unknownKeyCount: number;
  generatedAt: string;
}

/** Just which keymodes the tail holds. The chip strip on the profile needs
    this on every view, and the plays only when a chip is picked, so asking for
    the whole tail to know what to draw would trade a 2 kB answer for a
    megabyte of plays nobody opened. */
export interface KeymodePpKeyCounts {
  userId: number;
  /** Whether the ingest has ever recorded a pp play for this user. */
  tracked: boolean;
  /** Ascending, and only keymodes a mania source could name. */
  keyCounts: number[];
  generatedAt: string;
}

/* One keymode's list can never need more than this, because that is what the
   merged list is capped at on the reading side. */
export const KEYMODE_PP_PLAY_LIMIT = 200;

/**
 * Which row of a (player, map) group is the one a list quotes.
 *
 * A map played on twenty days is twenty rows, and exactly one of them is the
 * play everything here describes. `best_pp desc` alone does not decide it:
 * two days can tie at the same pp, and then the winner is whichever row the
 * engine happened to visit. Every place that picks, prunes or queues that row
 * orders by this, so the endpoint, the detail prune and both sweeps always
 * mean the same row. `rowid` is the final tiebreak because (country, user,
 * day, beatmap) is unique but a player who changed country can hold two rows
 * on the same day.
 */
export function activityMapBestRowOrder(alias: string): string {
  return `${alias}.best_pp desc, ${alias}.day desc, ${alias}.rowid`;
}

/**
 * The same ordering asked as a predicate: true when some other row of this
 * (player, map) sorts ahead of `alias`, so `alias` is not the row a list
 * quotes. What the work lists filter on, since a row can stop being the best
 * one between a sweep building its list and reaching it.
 */
export function activityMapNotBestRowSql(alias: string): string {
  return `exists (
    select 1 from player_activity_maps pam_best
    where pam_best.user_id = ${alias}.user_id and pam_best.beatmap_id = ${alias}.beatmap_id
      and (
        coalesce(pam_best.best_pp, -1) > coalesce(${alias}.best_pp, -1)
        or (coalesce(pam_best.best_pp, -1) = coalesce(${alias}.best_pp, -1) and pam_best.day > ${alias}.day)
        or (coalesce(pam_best.best_pp, -1) = coalesce(${alias}.best_pp, -1) and pam_best.day = ${alias}.day and pam_best.rowid < ${alias}.rowid)
      )
  )`;
}

export async function getPlayerKeymodePpTail(
  db: Db,
  userId: number,
  options: { perKeymodeLimit?: number } = {},
): Promise<KeymodePpTail> {
  const generatedAt = nowIso();
  const limit = Math.max(1, Math.floor(options.perKeymodeLimit ?? KEYMODE_PP_PLAY_LIMIT));
  if (!Number.isInteger(userId) || userId <= 0) {
    return { userId, tracked: false, trackedFrom: null, plays: [], unknownKeyCount: 0, generatedAt };
  }

  /* idx_player_activity_maps_user_beatmap makes this a per-user index range,
     not a scan: the heaviest player in the DB (3.9k rows) reads in 8ms warm.
     Every join is by rowid or by an indexed id on a mania-only table, so a
     convert simply finds nothing. `cs` is the beatmap's key count;
     map_search_index covers maps the maps projection never stored.

     The row_number is what makes every column below belong to one play. An
     earlier version grouped by beatmap and leaned on SQLite filling the bare
     columns from the row that won a lone max(): true, but only while the max
     is unique, and 339 (player, map) groups on the current DB tie at their
     best pp. activityMapBestRowOrder is the same ordering the detail prune
     and both sweeps use, so all four agree on which row that is. */
  const rows = (await exec(
    db,
    `with ranked as (
       select a.*, row_number() over (partition by a.beatmap_id order by ${activityMapBestRowOrder("a")}) as rn
       from player_activity_maps a
       where a.user_id = ? and a.best_pp > 0
     )
     select a.beatmap_id as beatmap_id,
            a.best_pp as pp,
            a.best_accuracy as accuracy,
            a.best_rank as rank,
            a.best_mods_json as mods_json,
            coalesce(a.best_played_at, a.last_played_at) as played_at,
            a.best_max_combo as max_combo,
            a.best_has_replay as has_replay,
            a.best_solo_score_id as solo_score_id,
            a.best_total_score as total_score,
            a.best_score_id as score_id,
            a.best_statistics_json as statistics_json,
            coalesce(m.cs, s.key_count) as key_count,
            coalesce(m.beatmapset_id, s.beatmapset_id) as beatmapset_id,
            coalesce(bs.title, s.title) as title,
            coalesce(bs.artist, s.artist) as artist,
            coalesce(m.version, s.version) as version,
            bs.creator as creator,
            coalesce(m.difficulty_rating, s.stars) as stars,
            coalesce(m.bpm, s.bpm) as bpm
     from ranked a
     left join maps_beatmaps m on m.beatmap_id = a.beatmap_id
     left join maps_beatmapsets bs on bs.beatmapset_id = m.beatmapset_id
     left join map_search_index s on s.beatmap_id = a.beatmap_id
     where a.rn = 1`,
    [userId],
  )).rows;

  const byKeyCount = new Map<number, KeymodePpPlay[]>();
  let unknownKeyCount = 0;
  for (const row of rows) {
    const rawKeyCount = Number(row.key_count);
    const keyCount = Number.isFinite(rawKeyCount) && rawKeyCount > 0 ? Math.round(rawKeyCount) : null;
    const pp = Number(row.pp);
    const beatmapId = Number(row.beatmap_id);
    if (!Number.isFinite(pp) || pp <= 0 || !Number.isSafeInteger(beatmapId) || beatmapId <= 0) continue;
    if (keyCount === null) {
      unknownKeyCount++;
      continue;
    }
    const accuracy = row.accuracy == null ? null : Number(row.accuracy);
    const beatmapsetId = Number(row.beatmapset_id);
    const soloScoreId = row.solo_score_id == null ? null : Number(row.solo_score_id);
    const scoreId = row.score_id == null ? null : Number(row.score_id);
    // An empty object is what a row wrote when the payload had no counts.
    const parsedStatistics = parseJson<OsuScoreStatistics>(row.statistics_json, {});
    const statistics = Object.keys(parsedStatistics).length > 0 ? parsedStatistics : null;
    const play: KeymodePpPlay = {
      beatmapId,
      keyCount,
      pp,
      beatmapsetId: Number.isSafeInteger(beatmapsetId) && beatmapsetId > 0 ? beatmapsetId : null,
      title: row.title == null ? null : String(row.title),
      artist: row.artist == null ? null : String(row.artist),
      version: row.version == null ? null : String(row.version),
      accuracy: accuracy != null && Number.isFinite(accuracy) ? accuracy : null,
      rank: row.rank == null ? null : String(row.rank),
      mods: getModAcronyms(parseJson<OsuMod[]>(row.mods_json, [])),
      playedAt: row.played_at == null ? null : String(row.played_at),
      maxCombo: row.max_combo == null ? null : Number(row.max_combo),
      hasReplay: row.has_replay == null ? null : Number(row.has_replay) === 1,
      soloScoreId,
      totalScore: readNumber(row.total_score),
      /* best_score_id prefers the legacy id, so it differing from the solo one
         is exactly the signal that this play was submitted on stable. */
      legacyScoreId: scoreId != null && soloScoreId != null && scoreId !== soloScoreId ? scoreId : null,
      statistics,
      creator: row.creator == null ? null : String(row.creator),
      stars: readNumber(row.stars),
      bpm: readNumber(row.bpm),
    };
    const bucket = byKeyCount.get(keyCount);
    if (bucket) bucket.push(play);
    else byKeyCount.set(keyCount, [play]);
  }

  const plays = [...byKeyCount.entries()]
    .sort((a, b) => a[0] - b[0])
    .flatMap(([, bucket]) => bucket.sort((a, b) => b.pp - a.pp || a.beatmapId - b.beatmapId).slice(0, limit));

  const trackedFromRow = rows.length > 0
    ? (await exec(db, "select min(day) as first_day from player_activity_maps where user_id = ?", [userId])).rows[0]
    : undefined;
  const trackedFrom = trackedFromRow?.first_day == null ? null : String(trackedFromRow.first_day);

  return {
    userId,
    tracked: rows.length > 0,
    trackedFrom,
    plays,
    unknownKeyCount,
    generatedAt,
  };
}

/**
 * The keymodes `getPlayerKeymodePpTail` would return plays for, without the
 * plays. Same index range and the same two key-count sources, so a chip drawn
 * from this always has a list behind it, and one it leaves out never had one.
 */
export async function getPlayerKeymodePpKeyCounts(db: Db, userId: number): Promise<KeymodePpKeyCounts> {
  const generatedAt = nowIso();
  if (!Number.isInteger(userId) || userId <= 0) {
    return { userId, tracked: false, keyCounts: [], generatedAt };
  }
  /* No row_number here: a map's key count is the same on every day it was
     played, so the best-row tiebreak the tail needs does not apply. Unknown
     key counts come back as one null row, which is what tells this a tracked
     player with nothing resolvable apart from an untracked one. */
  const rows = (await exec(
    db,
    `select distinct coalesce(m.cs, s.key_count) as key_count
     from player_activity_maps a
     left join maps_beatmaps m on m.beatmap_id = a.beatmap_id
     left join map_search_index s on s.beatmap_id = a.beatmap_id
     where a.user_id = ? and a.best_pp > 0`,
    [userId],
  )).rows;

  const keyCounts = new Set<number>();
  for (const row of rows) {
    const raw = Number(row.key_count);
    if (!Number.isFinite(raw) || raw <= 0) continue;
    keyCounts.add(Math.round(raw));
  }
  return {
    userId,
    tracked: rows.length > 0,
    keyCounts: [...keyCounts].sort((a, b) => a - b),
    generatedAt,
  };
}

function readNumber(value: unknown): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
