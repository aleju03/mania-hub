import type { InValue } from "@libsql/client";
import type { DbStatement, Db } from "../db.js";
import { exec, execBatch, json, parseJson } from "../db.js";
import type { OscScore, OsuBeatmap, OsuBeatmapset, ScoreUser } from "./types.js";

export function compactScoreForStorage(score: OscScore): OscScore {
  const { user: _user, beatmap, beatmapset: _beatmapset, ...stored } = score;
  return {
    ...stored,
    beatmap_id: stored.beatmap_id ?? beatmap?.id,
  };
}

export function compactScoresForStorage(scores: OscScore[]): OscScore[] {
  return scores.map(compactScoreForStorage);
}

/* Replaces a user's user_top_scores projection with a freshly fetched
   best-scores window. This projection is what serves best scores without an
   osu! API call (cached profile snapshots, pack card minting, goal
   baselines) for players who have no stored profile snapshot. Callers should
   persist display metadata for the same scores so hydration has user/beatmap
   rows to join against. */
export async function replaceUserTopScores(db: Db, userId: number, bestScores: OscScore[], refreshedAt: string): Promise<void> {
  const statements: DbStatement[] = [
    { sql: "delete from user_top_scores where user_id = ?", args: [userId] },
  ];
  bestScores.forEach((score, index) => {
    if (!Number.isSafeInteger(score.id) || score.id <= 0) return;
    const pp = typeof score.pp === "number" && Number.isFinite(score.pp) ? score.pp : null;
    statements.push({
      sql: `insert or replace into user_top_scores (user_id, score_id, position, score_json, pp, weighted_pp, ended_at, refreshed_at)
            values (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        userId,
        score.id,
        index + 1,
        json(compactScoreForStorage(score)),
        pp,
        pp == null ? null : pp * 0.95 ** index,
        score.ended_at ?? score.created_at ?? null,
        refreshedAt,
      ],
    });
  });
  await execBatch(db, statements);
}

export async function persistScoresDisplayMetadata(db: Db, scores: OscScore[], updatedAt: string): Promise<void> {
  const statements: DbStatement[] = [];
  const seenUsers = new Set<number>();
  const seenBeatmapsets = new Set<number>();
  const seenBeatmaps = new Set<number>();

  for (const score of scores) {
    if (score.user && !seenUsers.has(score.user.id)) {
      seenUsers.add(score.user.id);
      statements.push({
        sql: `insert into users (user_id, username, avatar_url, country_code, profile_json, updated_at)
              values (?, ?, ?, ?, ?, ?)
              on conflict(user_id) do update set
                username = excluded.username,
                avatar_url = excluded.avatar_url,
                country_code = coalesce(excluded.country_code, users.country_code),
                updated_at = excluded.updated_at`,
        args: [
          score.user.id,
          score.user.username,
          score.user.avatar_url,
          score.user.country_code,
          json(score.user),
          updatedAt,
        ],
      });
    }

    if (score.beatmapset && !seenBeatmapsets.has(score.beatmapset.id)) {
      seenBeatmapsets.add(score.beatmapset.id);
      statements.push({
        sql: `insert into beatmapsets (beatmapset_id, title, artist, creator, status, covers_json, metadata_json, updated_at)
              values (?, ?, ?, ?, ?, ?, ?, ?)
              on conflict(beatmapset_id) do update set
                title = excluded.title,
                artist = excluded.artist,
                creator = excluded.creator,
                status = excluded.status,
                covers_json = excluded.covers_json,
                metadata_json = case
                  when json_valid(beatmapsets.metadata_json) and json_valid(excluded.metadata_json)
                  then json_patch(beatmapsets.metadata_json, excluded.metadata_json)
                  else coalesce(excluded.metadata_json, beatmapsets.metadata_json)
                end,
                updated_at = excluded.updated_at`,
        args: [
          score.beatmapset.id,
          score.beatmapset.title,
          score.beatmapset.artist,
          score.beatmapset.creator ?? null,
          score.beatmapset.status ?? null,
          json(score.beatmapset.covers ?? {}),
          json(score.beatmapset),
          updatedAt,
        ],
      });
    }

    if (score.beatmap && !seenBeatmaps.has(score.beatmap.id)) {
      seenBeatmaps.add(score.beatmap.id);
      statements.push({
        sql: `insert into beatmaps (beatmap_id, beatmapset_id, mode, status, cs, difficulty_rating, bpm, max_combo, version, url, metadata_json, updated_at)
              values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              on conflict(beatmap_id) do update set
                beatmapset_id = excluded.beatmapset_id,
                mode = excluded.mode,
                status = excluded.status,
                cs = excluded.cs,
                difficulty_rating = excluded.difficulty_rating,
                bpm = excluded.bpm,
                max_combo = excluded.max_combo,
                version = excluded.version,
                url = excluded.url,
                metadata_json = case
                  when json_valid(beatmaps.metadata_json) and json_valid(excluded.metadata_json)
                  then json_patch(beatmaps.metadata_json, excluded.metadata_json)
                  else coalesce(excluded.metadata_json, beatmaps.metadata_json)
                end,
                updated_at = excluded.updated_at`,
        args: [
          score.beatmap.id,
          score.beatmap.beatmapset_id,
          score.beatmap.mode,
          score.beatmap.status ?? null,
          score.beatmap.cs,
          score.beatmap.difficulty_rating,
          score.beatmap.bpm,
          score.beatmap.max_combo ?? null,
          score.beatmap.version,
          score.beatmap.url,
          json(score.beatmap),
          updatedAt,
        ],
      });
    }
  }

  await execBatch(db, statements);
}

export async function hydrateScoresDisplayMetadata(db: Db, scores: OscScore[]): Promise<OscScore[]> {
  const userIds = uniquePositiveIntegers(scores.map((score) => score.user_id));
  const beatmapIds = uniquePositiveIntegers(scores.map((score) => score.beatmap_id ?? score.beatmap?.id));
  const users = await readUsers(db, userIds);
  const beatmaps = await readBeatmaps(db, beatmapIds);
  return scores.map((score) => hydrateScoreDisplayMetadata(score, users, beatmaps));
}

function hydrateScoreDisplayMetadata(
  score: OscScore,
  users: Map<number, ScoreUser>,
  beatmaps: Map<number, { beatmap?: OsuBeatmap; beatmapset?: OsuBeatmapset }>,
): OscScore {
  const user = users.get(score.user_id) ?? score.user;
  const beatmapId = score.beatmap_id ?? score.beatmap?.id;
  const metadata = beatmapId == null ? undefined : beatmaps.get(beatmapId);
  return {
    ...score,
    user: user ? mergeScoreUser(score.user, user) : score.user,
    beatmap: score.beatmap ?? metadata?.beatmap,
    beatmapset: score.beatmapset ?? metadata?.beatmapset,
  };
}

function mergeScoreUser(current: ScoreUser | undefined, stored: ScoreUser): ScoreUser {
  if (!current) return stored;
  return {
    ...current,
    id: stored.id,
    username: stored.username || current.username,
    avatar_url: stored.avatar_url || current.avatar_url,
    country_code: stored.country_code || current.country_code,
  };
}

async function readUsers(db: Db, userIds: number[]): Promise<Map<number, ScoreUser>> {
  const rows = await selectRowsByIntegerSet(
    db,
    "select user_id, username, avatar_url, country_code from users where user_id in",
    userIds,
  );
  return new Map(rows.flatMap((row) => {
    const id = Number(row.user_id);
    if (!Number.isFinite(id) || id <= 0 || row.username == null) return [];
    return [[id, {
      id,
      username: String(row.username),
      avatar_url: String(row.avatar_url ?? ""),
      country_code: String(row.country_code ?? ""),
    } satisfies ScoreUser]];
  }));
}

async function readBeatmaps(db: Db, beatmapIds: number[]): Promise<Map<number, { beatmap?: OsuBeatmap; beatmapset?: OsuBeatmapset }>> {
  const rows = await selectRowsByIntegerSet(
    db,
    `select
       b.beatmap_id,
       b.beatmapset_id,
       b.mode,
       b.status as beatmap_status,
       b.cs,
       b.difficulty_rating,
       b.bpm,
       b.max_combo,
       b.version,
       b.url,
       b.metadata_json as beatmap_metadata_json,
       bs.title,
       bs.artist,
       bs.creator,
       bs.status as beatmapset_status,
       bs.covers_json,
       bs.metadata_json as beatmapset_metadata_json
     from beatmaps b
     left join beatmapsets bs on bs.beatmapset_id = b.beatmapset_id
     where b.beatmap_id in`,
    beatmapIds,
  );
  return new Map(rows.flatMap((row) => {
    const beatmap = rowBeatmap(row);
    if (!beatmap) return [];
    return [[beatmap.id, { beatmap, beatmapset: rowBeatmapset(row) }]];
  }));
}

function rowBeatmap(row: Record<string, unknown>): OsuBeatmap | undefined {
  const id = Number(row.beatmap_id);
  const beatmapsetId = Number(row.beatmapset_id);
  if (!Number.isFinite(id) || id <= 0 || !Number.isFinite(beatmapsetId) || beatmapsetId <= 0 || row.version == null) return undefined;
  const metadata = parseJson<Record<string, unknown>>(row.beatmap_metadata_json, {});
  return {
    ...metadata,
    id,
    beatmapset_id: beatmapsetId,
    difficulty_rating: readNumber(row.difficulty_rating, readNumber(metadata.difficulty_rating, 0)),
    mode: String(row.mode ?? metadata.mode ?? "mania"),
    status: row.beatmap_status == null ? readOptionalString(metadata.status) : String(row.beatmap_status),
    cs: readNumber(row.cs, readNumber(metadata.cs, 0)),
    bpm: readNumber(row.bpm, readNumber(metadata.bpm, 0)),
    max_combo: row.max_combo == null ? readOptionalNumber(metadata.max_combo) : Number(row.max_combo),
    version: String(row.version),
    url: String(row.url ?? metadata.url ?? `https://osu.ppy.sh/beatmaps/${id}`),
  };
}

function rowBeatmapset(row: Record<string, unknown>): OsuBeatmapset | undefined {
  const id = Number(row.beatmapset_id);
  if (!Number.isFinite(id) || id <= 0 || row.title == null || row.artist == null) return undefined;
  const metadata = parseJson<Record<string, unknown>>(row.beatmapset_metadata_json, {});
  return {
    ...metadata,
    id,
    title: String(row.title),
    artist: String(row.artist),
    creator: row.creator == null ? readOptionalString(metadata.creator) : String(row.creator),
    status: row.beatmapset_status == null ? readOptionalString(metadata.status) : String(row.beatmapset_status),
    covers: parseJson<OsuBeatmapset["covers"]>(row.covers_json, readRecord(metadata.covers)),
  };
}

function readNumber(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function readOptionalNumber(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

async function selectRowsByIntegerSet(db: Db, sqlPrefix: string, values: number[], sqlSuffix = ""): Promise<Record<string, unknown>[]> {
  const ids = uniquePositiveIntegers(values);
  const rows: Record<string, unknown>[] = [];
  for (let index = 0; index < ids.length; index += 900) {
    const chunk = ids.slice(index, index + 900);
    if (chunk.length === 0) continue;
    const placeholders = chunk.map(() => "?").join(",");
    rows.push(...(await exec(db, `${sqlPrefix} (${placeholders}) ${sqlSuffix}`, chunk as InValue[])).rows);
  }
  return rows;
}

function uniquePositiveIntegers(values: Array<number | undefined | null>): number[] {
  return [...new Set(values
    .map((value) => Math.floor(Number(value)))
    .filter((value) => Number.isSafeInteger(value) && value > 0))];
}
