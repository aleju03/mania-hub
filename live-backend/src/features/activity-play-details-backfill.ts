/**
 * One-time fill of the play-detail columns on `player_activity_maps`.
 *
 * The per-keymode lists show plays this site tracked below a profile's osu!
 * top-200 window, and a row wants what any other score row shows: its combo
 * and, when the play kept one, a replay button. Ingest records those now
 * (`best_max_combo`, `best_has_replay`, `best_solo_score_id`,
 * `best_total_score`, `best_played_at`), but every row written before the
 * columns existed reads null, and the raw score payload they would have come
 * from is pruned after 14 days.
 *
 * So they are re-derived from what the database still holds, and only from
 * that: no osu! API call belongs on a page that is drawing 200 rows. Five
 * local sources are folded into one lookup table, best first:
 *
 *   1. score_events        - the raw payload, while it is still inside retention
 *   2. top_play_events     - the payload of every play that ever entered a top
 *   3. snipe_events        - the payload of a play that took a #1
 *   4/5. the board tables  - no combo, but they carry has_replay and an id
 *
 * A candidate is matched to a row by score id, in the id space the row itself
 * recorded (`best_score_id`, which prefers the legacy id when a score has
 * one), so every source computes that same preferred id. v1 and v2 matched on
 * (user, beatmap, pp to two decimals) instead, which is not an identity: two
 * plays of one map can round to the same pp, and 321 groups on the live
 * database did, so a row could be handed another day's replay link. Score ids
 * cost nothing here (every row with pp carries one, and id matching reaches
 * 245,028 of the 245,491 rows pp matching did) and they cannot be ambiguous.
 *
 * The board tables join on `is_lazer = 1` only: their score id is
 * legacy-preferred, and only a lazer score is guaranteed to have no legacy id
 * beside it, which is what makes the stored id the solo one /replay resolves.
 * `snipe_events.score_id` is always the solo id, so it matches lazer plays for
 * the same reason.
 *
 * Two heals run before the fill, because v2 already shipped:
 *  - details on any row that is not its map's best come off, so one play per
 *    map keeps them (51,601 rows on the current database);
 *  - details on a row v2 could only have guessed at (its stored solo id is
 *    contradicted by the score its own id resolves to, or another row of the
 *    same map shares its rounded pp) come off too, and the fill below puts the
 *    right ones back where a candidate exists.
 *
 * What no local source has stays null, and a null still reads as unknown
 * rather than as zero, so a row with no combo shows a dash instead of "0x".
 */
import { exec, type Db } from "../db.js";
import { nowIso } from "../shared/score.js";
import { activityMapNotBestRowSql } from "./keymode-pp.js";

// v3: v1/v2 matched candidates by rounded pp, which could attach another
// play's id, and wrote details onto every day of a map rather than its best.
const META_KEY = "activity_map_play_details_backfill:v3";
/** Real table, not a temp one: the busy-retry layer can reopen the connection
    mid-run, which would take a temp table with it. Dropped either way. */
const HELPER_TABLE = "_activity_play_details_backfill";
/** Rowid window per update statement. Small enough that the write lock is
    handed back often, since ingest is writing the whole time. */
const DEFAULT_CHUNK_ROWS = 20_000;
/** Breather between chunks, for the same reason. */
const CHUNK_PAUSE_MS = 25;

/** The four columns that describe one play, and therefore belong to exactly
    one row per map. best_played_at is not among them: it is that day's own
    fact, costs one timestamp, and is read through a coalesce anyway. */
const DETAIL_COLUMNS = ["best_max_combo", "best_has_replay", "best_solo_score_id", "best_total_score"] as const;
const CLEAR_DETAILS_SQL = DETAIL_COLUMNS.map((column) => `${column} = null`).join(", ");
const HAS_DETAILS_SQL = `(${DETAIL_COLUMNS.map((column) => `a.${column} is not null`).join(" or ")})`;

/* True when this row is not the one a list quotes. */
const NOT_BEST_ROW_SQL = activityMapNotBestRowSql("a");

/** The candidate that is this row's own score, in the id space it recorded. */
const MATCH_SQL = `d.user_id = a.user_id and d.beatmap_id = a.beatmap_id and d.match_id = a.best_score_id`;

/* The boot pass, so a work list that this one shrinks can wait it out rather
   than being built against rows it is about to fill. Null until boot starts
   it, and it never rejects: a failed pass must not stall its waiters. */
let bootPass: Promise<unknown> | null = null;

export function trackActivityPlayDetailsBackfill(pass: Promise<unknown>): void {
  bootPass = pass.catch(() => undefined);
}

export function whenActivityPlayDetailsBackfilled(): Promise<unknown> {
  return bootPass ?? Promise.resolve();
}

export interface ActivityPlayDetailsBackfillResult {
  /** True when a previous run already finished and nothing was done. */
  skipped: boolean;
  /** Rows in the lookup table this run built. */
  candidates: number;
  /** Rows that lost details they should never have kept. */
  healed: number;
  /** Activity rows that gained at least one detail. */
  updated: number;
}

export async function backfillActivityPlayDetails(
  db: Db,
  options: { force?: boolean; chunkRows?: number } = {},
): Promise<ActivityPlayDetailsBackfillResult> {
  const chunkRows = Math.max(1, Math.floor(options.chunkRows ?? DEFAULT_CHUNK_ROWS));
  if (!options.force) {
    const done = (await exec(db, "select 1 from live_meta where key = ? limit 1", [META_KEY])).rows[0];
    if (done) return { skipped: true, candidates: 0, healed: 0, updated: 0 };
  }

  let candidates = 0;
  let healed = 0;
  let updated = 0;
  try {
    candidates = await buildLookupTable(db);
    // One walk of the table per statement, in the same rowid windows, so the
    // write lock is handed back at the same cadence throughout.
    healed = await walkChunks(db, chunkRows, healSql());
    updated = await walkChunks(db, chunkRows, fillSql());
  } finally {
    await exec(db, `drop table if exists ${HELPER_TABLE}`).catch(() => {});
  }

  await exec(
    db,
    "insert or replace into live_meta (key, value_json, updated_at) values (?, ?, ?)",
    [META_KEY, JSON.stringify({ candidates, healed, updated }), nowIso()],
  );
  return { skipped: false, candidates, healed, updated };
}

async function walkChunks(db: Db, chunkRows: number, sql: string): Promise<number> {
  const maxRowid = Number((await exec(db, "select max(rowid) as max_rowid from player_activity_maps")).rows[0]?.max_rowid ?? 0);
  let affected = 0;
  for (let from = 0; from < maxRowid; from += chunkRows) {
    const result = await exec(db, sql, [from, Math.min(from + chunkRows, maxRowid)]);
    affected += Number(result.rowsAffected ?? 0);
    if (from + chunkRows < maxRowid) await new Promise((resolve) => setTimeout(resolve, CHUNK_PAUSE_MS));
  }
  return affected;
}

/** Every locally-known score -> play detail, best source first. */
async function buildLookupTable(db: Db): Promise<number> {
  await exec(db, `drop table if exists ${HELPER_TABLE}`);
  await exec(db, `
    create table ${HELPER_TABLE} (
      user_id integer not null,
      beatmap_id integer not null,
      match_id integer,
      max_combo integer,
      has_replay integer,
      solo_score_id integer,
      total_score integer,
      ended_at text,
      priority integer not null
    )
  `);
  // Mania only (ruleset 3): the activity rows this fills are mania rows.
  await exec(db, `
    insert into ${HELPER_TABLE} (user_id, beatmap_id, match_id, max_combo, has_replay, solo_score_id, total_score, ended_at, priority)
    select user_id, beatmap_id,
           coalesce(nullif(legacy_score_id, 0), score_id),
           json_extract(score_json, '$.max_combo'),
           case when has_replay then 1 else 0 end,
           json_extract(score_json, '$.id'),
           coalesce(json_extract(score_json, '$.classic_total_score'), json_extract(score_json, '$.total_score'), total_score),
           ended_at,
           1
    from score_events
    where ruleset_id = 3 and pp is not null and pp > 0
  `);
  await exec(db, `
    insert into ${HELPER_TABLE} (user_id, beatmap_id, match_id, max_combo, has_replay, solo_score_id, total_score, ended_at, priority)
    select user_id, coalesce(score_beatmap_id, json_extract(payload_json, '$.score.beatmap_id')),
           coalesce(nullif(json_extract(payload_json, '$.score.legacy_score_id'), 0), json_extract(payload_json, '$.score.id')),
           json_extract(payload_json, '$.score.max_combo'),
           case when json_extract(payload_json, '$.score.has_replay') then 1 else 0 end,
           json_extract(payload_json, '$.score.id'),
           coalesce(json_extract(payload_json, '$.score.classic_total_score'), json_extract(payload_json, '$.score.total_score')),
           coalesce(json_extract(payload_json, '$.score.ended_at'), score_time),
           2
    from top_play_events
    where pp > 0 and coalesce(score_beatmap_id, json_extract(payload_json, '$.score.beatmap_id')) is not null
  `);
  // A snipe payload keeps the play's own id and replay flag but no combo.
  await exec(db, `
    insert into ${HELPER_TABLE} (user_id, beatmap_id, match_id, max_combo, has_replay, solo_score_id, total_score, ended_at, priority)
    select sniper_id, beatmap_id,
           score_id,
           null,
           case when json_extract(payload_json, '$.hasReplay') then 1 else 0 end,
           score_id,
           json_extract(payload_json, '$.totalScore'),
           json_extract(payload_json, '$.timestamp'),
           3
    from snipe_events
    where json_extract(payload_json, '$.pp') > 0
  `);
  for (const [table, priority] of [["country_beatmap_scores", 4], ["country_beatmap_score_pbs", 5]] as const) {
    await exec(db, `
      insert into ${HELPER_TABLE} (user_id, beatmap_id, match_id, max_combo, has_replay, solo_score_id, total_score, ended_at, priority)
      select user_id, beatmap_id, score_id, null, has_replay, score_id, total_score, ended_at, ${priority}
      from ${table}
      where is_lazer = 1 and pp is not null and pp > 0
    `);
  }
  await exec(db, `delete from ${HELPER_TABLE} where match_id is null or match_id <= 0`);
  await exec(db, `create index ${HELPER_TABLE}_lookup on ${HELPER_TABLE}(user_id, beatmap_id, match_id, priority)`);
  return Number((await exec(db, `select count(*) as n from ${HELPER_TABLE}`)).rows[0]?.n ?? 0);
}

/* Take details off the rows that should not be holding them: every row that is
   not its map's best, and every row whose details v1/v2 could only have
   guessed at. The fill below refills the second group from the right score. */
function healSql(): string {
  return `
    update player_activity_maps as a
    set ${CLEAR_DETAILS_SQL}
    where a.rowid > ? and a.rowid <= ?
      and ${HAS_DETAILS_SQL}
      and (
        ${NOT_BEST_ROW_SQL}
        or exists (
          select 1 from ${HELPER_TABLE} d
          where ${MATCH_SQL} and d.solo_score_id is not null
            and a.best_solo_score_id is not null and d.solo_score_id <> a.best_solo_score_id
        )
        or exists (
          select 1 from player_activity_maps c
          where c.user_id = a.user_id and c.beatmap_id = a.beatmap_id and c.rowid <> a.rowid
            and cast(round(c.best_pp * 100) as integer) = cast(round(a.best_pp * 100) as integer)
        )
      )
  `;
}

/* Each field comes from the best-priority candidate that carries it, and every
   candidate here is the row's own score, so they cannot disagree about which
   play they describe. The `exists` guard keeps the statement from rewriting
   the millions of rows nothing matches. */
function fillSql(): string {
  const pick = (column: string) =>
    `(select d.${column} from ${HELPER_TABLE} d where ${MATCH_SQL} and d.${column} is not null order by d.priority limit 1)`;
  return `
    update player_activity_maps as a
    set best_max_combo = coalesce(a.best_max_combo, ${pick("max_combo")}),
        best_has_replay = coalesce(a.best_has_replay, ${pick("has_replay")}),
        best_solo_score_id = coalesce(a.best_solo_score_id, ${pick("solo_score_id")}),
        best_total_score = coalesce(a.best_total_score, ${pick("total_score")}),
        best_played_at = coalesce(a.best_played_at, ${pick("ended_at")})
    where a.rowid > ? and a.rowid <= ?
      and a.best_pp > 0
      and (a.best_max_combo is null or a.best_has_replay is null or a.best_solo_score_id is null
           or a.best_total_score is null or a.best_played_at is null)
      and not ${NOT_BEST_ROW_SQL}
      and exists (select 1 from ${HELPER_TABLE} d where ${MATCH_SQL})
  `;
}
