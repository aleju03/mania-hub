import type { InValue } from "@libsql/client";
import { readConfig } from "../config.js";
import { createDb, exec, json, migrate } from "../db.js";
import { compactCountryMapsSnapshots } from "../features/maps.js";
import { toStoredScoreEvent } from "../ingest/score-ingestor.js";
import { compactLiveEventLogPayloadForStorage } from "../live/event-log.js";
import { getModAcronyms, getScoreTimestamp, nowIso } from "../shared/score.js";
import type { OscScore } from "../shared/types.js";

interface CompactOptions {
  batchSize: number;
  vacuum: boolean;
}

const options = readOptions(process.argv.slice(2));
const db = await createDb(readConfig());

await migrate(db);

const farmed = await compactMapsFarmedOverlay(options.batchSize);
console.log(`country_maps_farmed_scores: compacted ${farmed.compacted}, failed ${farmed.failed}, scanned ${farmed.scanned}`);
await releaseMemory();

const snapshots = await compactCountryMapsSnapshots(db);
console.log(`country_maps_snapshots: compacted ${snapshots.compacted}, skipped ${snapshots.skipped}, scanned ${snapshots.scanned}`);
await releaseMemory();

const scoreEvents = await compactScoreEvents(options.batchSize);
console.log(`score_events: compacted ${scoreEvents.compacted}, failed ${scoreEvents.failed}, scanned ${scoreEvents.scanned}`);
await releaseMemory();

const events = await compactLiveEventLog(options.batchSize);
console.log(`live_event_log: compacted ${events.compacted}, skipped ${events.skipped}, scanned ${events.scanned}`);
await releaseMemory();

const apiCalls = await compactApiCallLog();
console.log(`api_call_log: compacted ${apiCalls.compactedRows} rows across ${apiCalls.compactedTargets} targets`);
await releaseMemory();

if (options.vacuum) {
  console.log("Running VACUUM. Keep the backend stopped until this finishes.");
  await db.execute("vacuum");
  console.log("VACUUM finished.");
}

db.close();

async function compactMapsFarmedOverlay(batchSize: number): Promise<{ scanned: number; compacted: number; failed: number }> {
  const result = { scanned: 0, compacted: 0, failed: 0 };

  while (true) {
    const rows = (await exec(
      db,
      `select country, user_id, beatmap_id, score_json, updated_at
       from country_maps_farmed_scores
       where score_json is not null
         and score_json <> ''
         and score_json <> '{}'
         and json_valid(score_json)
       limit ?`,
      [batchSize],
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

    await releaseMemory();
    if (rows.length < batchSize) break;
  }

  return result;
}

async function compactLiveEventLog(batchSize: number): Promise<{ scanned: number; compacted: number; skipped: number }> {
  let scanned = 0;
  let compacted = 0;
  let skipped = 0;
  let afterSequence = 0;

  while (true) {
    const rows = (await exec(
      db,
      `select sequence, type, country, payload_json
       from live_event_log
       where type = 'tracker_score'
         and sequence > ?
       order by sequence asc
       limit ?`,
      [afterSequence, batchSize],
    )).rows;

    if (rows.length === 0) break;
    scanned += rows.length;

    for (const row of rows) {
      afterSequence = Math.max(afterSequence, Number(row.sequence));
      const payload = parseUnknownJson(row.payload_json);
      if (payload == null) {
        skipped++;
        continue;
      }
      const compact = compactLiveEventLogPayloadForStorage(String(row.type), row.country == null ? null : String(row.country), payload);
      if (JSON.stringify(compact) === JSON.stringify(payload)) {
        skipped++;
        continue;
      }
      await exec(
        db,
        "update live_event_log set payload_json = ? where sequence = ?",
        [json(compact), Number(row.sequence)],
      );
      compacted++;
    }

    await releaseMemory();
    if (rows.length < batchSize) break;
  }

  return { scanned, compacted, skipped };
}

async function compactScoreEvents(batchSize: number): Promise<{ scanned: number; compacted: number; failed: number }> {
  const result = { scanned: 0, compacted: 0, failed: 0 };
  let afterId = 0;

  while (true) {
    const rows = (await exec(
      db,
      `select id, score_json, received_at
       from score_events
       where id > ?
         and json_valid(score_json)
         and (score_json like '%"user"%' or score_json like '%"beatmap"%' or score_json like '%"beatmapset"%')
       order by id asc
       limit ?`,
      [afterId, batchSize],
    )).rows;

    if (rows.length === 0) break;
    result.scanned += rows.length;

    for (const row of rows) {
      afterId = Math.max(afterId, Number(row.id));
      const score = parseScore(row.score_json);
      if (!score) {
        result.failed++;
        continue;
      }

      await persistScoreDisplayMetadata(score, String(row.received_at ?? nowIso()));
      await exec(
        db,
        "update score_events set score_json = ? where id = ?",
        [json(toStoredScoreEvent(score)), Number(row.id)],
      );
      result.compacted++;
    }

    await releaseMemory();
    if (rows.length < batchSize) break;
  }

  return result;
}

async function releaseMemory(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  (globalThis as { gc?: () => void }).gc?.();
}

async function compactApiCallLog(): Promise<{ compactedTargets: number; compactedRows: number }> {
  await exec(
    db,
    `create index if not exists idx_api_call_log_compact_source
       on api_call_log(provider, caller, path)
       where target_id is null and (caller <> '' or path <> '')`,
  );
  const compactedTargets = Number((await exec(
    db,
    `select count(*) as count
     from (
       select 1
       from api_call_log
       where target_id is null
         and (caller <> '' or path <> '')
       group by provider, caller, path
     )`,
  )).rows[0]?.count ?? 0);
  await exec(
    db,
    `insert or ignore into api_call_targets (provider, caller, path)
     select provider, caller, path
     from api_call_log
     where target_id is null
       and (caller <> '' or path <> '')
     group by provider, caller, path`,
  );
  const result = await exec(
    db,
    `update api_call_log
     set target_id = (
           select t.id
           from api_call_targets t
           where t.provider = api_call_log.provider
             and t.caller = api_call_log.caller
             and t.path = api_call_log.path
         ),
         caller = '',
         path = ''
     where target_id is null
       and (caller <> '' or path <> '')`,
  );
  await exec(db, "drop index if exists idx_api_call_log_compact_source");

  return { compactedTargets, compactedRows: Number(result.rowsAffected ?? 0) };
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
  const parsed = parseUnknownJson(value) as Partial<OscScore> | null;
  if (!parsed || !Number.isFinite(parsed.id) || !Number.isFinite(parsed.user_id)) return null;
  return parsed as OscScore;
}

function parseUnknownJson(value: unknown): unknown | null {
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value) as unknown;
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
