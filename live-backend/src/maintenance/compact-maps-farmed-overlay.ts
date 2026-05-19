import type { InValue } from "@libsql/client";
import { readConfig } from "../config.js";
import { createDb, exec, json, migrate } from "../db.js";
import { getModAcronyms, getScoreTimestamp, nowIso } from "../shared/score.js";
import type { OscScore } from "../shared/types.js";

interface CompactOptions {
  batchSize: number;
  vacuum: boolean;
}

interface CompactResult {
  scanned: number;
  compacted: number;
  failed: number;
}

const options = readOptions(process.argv.slice(2));
const db = await createDb(readConfig());

await migrate(db);
const result = await compactMapsFarmedOverlay(options);
console.log(`Compacted ${result.compacted} country_maps_farmed_scores rows (${result.failed} failed, ${result.scanned} scanned).`);

if (options.vacuum) {
  console.log("Running VACUUM. Keep the backend stopped until this finishes.");
  await db.execute("vacuum");
  console.log("VACUUM finished.");
}

db.close();

async function compactMapsFarmedOverlay(options: CompactOptions): Promise<CompactResult> {
  const result: CompactResult = { scanned: 0, compacted: 0, failed: 0 };

  while (true) {
    const rows = (await exec(
      db,
      `select country, user_id, beatmap_id, score_id, score_json, updated_at
       from country_maps_farmed_scores
       where score_json is not null
         and score_json <> ''
         and score_json <> '{}'
         and json_valid(score_json)
       limit ?`,
      [options.batchSize],
    )).rows;

    if (rows.length === 0) break;
    result.scanned += rows.length;

    for (const row of rows) {
      const score = parseScore(row.score_json);
      if (!score) {
        result.failed++;
        continue;
      }

      await persistScoreDisplayMetadata(score, String(row.updated_at ?? nowIso()));
      await exec(
        db,
        `update country_maps_farmed_scores
         set score_id = ?,
             score_json = '{}',
             mods_json = ?,
             score_url = ?,
             played_at = ?
         where country = ? and user_id = ? and beatmap_id = ?`,
        [
          getMapsFarmedDisplayScoreId(score),
          json(getModAcronyms(score.mods)),
          getScoreUrl(score),
          getScoreTimestamp(score) || null,
          String(row.country),
          Number(row.user_id),
          Number(row.beatmap_id),
        ],
      );
      result.compacted++;
    }

    if (rows.length < options.batchSize) break;
  }

  return result;
}

async function persistScoreDisplayMetadata(score: OscScore, updatedAt: string): Promise<void> {
  const statements: Array<{ sql: string; args: InValue[] }> = [];
  if (score.user) {
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

  if (score.beatmapset) {
    statements.push({
      sql: `insert into beatmapsets (beatmapset_id, title, artist, creator, status, covers_json, metadata_json, updated_at)
            values (?, ?, ?, ?, ?, ?, ?, ?)
            on conflict(beatmapset_id) do update set
              title = excluded.title,
              artist = excluded.artist,
              creator = excluded.creator,
              status = excluded.status,
              covers_json = excluded.covers_json,
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

  if (score.beatmap) {
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

  for (const statement of statements) {
    await exec(db, statement.sql, statement.args);
  }
}

function parseScore(value: unknown): OscScore | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value) as Partial<OscScore>;
    if (!Number.isFinite(parsed.id) || !Number.isFinite(parsed.user_id)) return null;
    return parsed as OscScore;
  } catch {
    return null;
  }
}

function getMapsFarmedDisplayScoreId(score: OscScore): number {
  return score.legacy_score_id != null && score.legacy_score_id > 0 ? score.legacy_score_id : score.id;
}

function getScoreUrl(score: OscScore): string | null {
  if (score.id <= 0) return null;
  if (score.type === "solo_score") return `https://osu.ppy.sh/scores/${score.id}`;
  return `https://osu.ppy.sh/scores/${score.beatmap?.mode ?? "mania"}/${score.id}`;
}

function readOptions(args: string[]): CompactOptions {
  const batchArg = args.find((arg) => arg.startsWith("--batch-size="));
  const batchSize = Math.max(1, Math.min(5_000, Number(batchArg?.slice("--batch-size=".length) ?? 500)));
  return {
    batchSize: Number.isFinite(batchSize) ? batchSize : 500,
    vacuum: args.includes("--vacuum"),
  };
}
