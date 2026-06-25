import { readConfig } from "../config.js";
import { createDb, exec, json, migrate } from "../db.js";
import { compactCountryMapsSnapshots } from "../features/maps.js";
import { toStoredScoreEvent } from "../ingest/score-ingestor.js";
import { compactLiveEventLogPayloadForStorage } from "../live/event-log.js";
import { getModAcronyms, getScoreTimestamp, nowIso } from "../shared/score.js";
import { compactScoreForStorage, compactScoresForStorage, persistScoresDisplayMetadata } from "../shared/score-storage.js";
import type { CountryTopPlay, OscScore } from "../shared/types.js";

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

const profileSnapshots = await compactProfileSnapshots(options.batchSize);
console.log(`profile_snapshots: compacted ${profileSnapshots.compacted}, failed ${profileSnapshots.failed}, scanned ${profileSnapshots.scanned}`);
await releaseMemory();

const topPlays = await compactTopPlayEvents(options.batchSize);
console.log(`top_play_events: compacted ${topPlays.compacted}, failed ${topPlays.failed}, scanned ${topPlays.scanned}`);
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

const apiTargets = await pruneOrphanApiCallTargets();
console.log(`api_call_targets: pruned ${apiTargets.pruned} orphan targets`);
await releaseMemory();

if (options.vacuum) {
  console.log("Running VACUUM. Keep the backend stopped until this finishes.");
  await db.execute("vacuum");
  console.log("VACUUM finished.");
}

db.close();

async function compactProfileSnapshots(batchSize: number): Promise<{ scanned: number; compacted: number; failed: number }> {
  const result = { scanned: 0, compacted: 0, failed: 0 };
  let afterUserId = 0;

  while (true) {
    const rows = (await exec(
      db,
      `select user_id, updated_at
       from profile_snapshots
       where user_id > ?
         and json_valid(best_scores_json)
         and (
           best_scores_json like '%"user"%'
           or best_scores_json like '%"beatmap"%'
           or best_scores_json like '%"beatmapset"%'
         )
       order by user_id asc
       limit ?`,
      [afterUserId, batchSize],
    )).rows;

    if (rows.length === 0) break;
    result.scanned += rows.length;

    for (const row of rows) {
      afterUserId = Math.max(afterUserId, Number(row.user_id));
      const snapshotRow = (await exec(
        db,
        "select best_scores_json from profile_snapshots where user_id = ?",
        [Number(row.user_id)],
      )).rows[0];
      const scores = parseScores(snapshotRow?.best_scores_json);
      if (!scores) {
        result.failed++;
        continue;
      }
      const updatedAt = String(row.updated_at ?? nowIso());
      await persistScoresDisplayMetadata(db, scores, updatedAt);
      await exec(
        db,
        "update profile_snapshots set best_scores_json = ? where user_id = ?",
        [json(compactScoresForStorage(scores)), Number(row.user_id)],
      );
      result.compacted++;
      await releaseMemory();
    }

    await releaseMemory();
    if (rows.length < batchSize) break;
  }

  return result;
}

async function compactTopPlayEvents(batchSize: number): Promise<{ scanned: number; compacted: number; failed: number }> {
  const result = { scanned: 0, compacted: 0, failed: 0 };
  let afterRowid = 0;

  while (true) {
    const rows = (await exec(
      db,
      `select rowid, detected_at
       from top_play_events
       where rowid > ?
         and json_valid(payload_json)
         and (
           payload_json like '%"user"%'
           or payload_json like '%"beatmap"%'
           or payload_json like '%"beatmapset"%'
         )
       order by rowid asc
       limit ?`,
      [afterRowid, batchSize],
    )).rows;

    if (rows.length === 0) break;
    result.scanned += rows.length;

    for (const row of rows) {
      afterRowid = Math.max(afterRowid, Number(row.rowid));
      const eventRow = (await exec(
        db,
        "select payload_json from top_play_events where rowid = ?",
        [Number(row.rowid)],
      )).rows[0];
      const event = parseUnknownJson(eventRow?.payload_json) as Partial<CountryTopPlay> | null;
      if (!event?.score) {
        result.failed++;
        continue;
      }
      const updatedAt = String(row.detected_at ?? nowIso());
      await persistScoresDisplayMetadata(db, [event.score], updatedAt);
      await exec(
        db,
        "update top_play_events set payload_json = ? where rowid = ?",
        [json(compactTopPlayPayload(event)), Number(row.rowid)],
      );
      result.compacted++;
      await releaseMemory();
    }

    await releaseMemory();
    if (rows.length < batchSize) break;
  }

  return result;
}

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

      await persistScoresDisplayMetadata(db, [score], String(row.updated_at ?? nowIso()));
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

      await persistScoresDisplayMetadata(db, [score], String(row.received_at ?? nowIso()));
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

async function pruneOrphanApiCallTargets(): Promise<{ pruned: number }> {
  let pruned = 0;
  while (true) {
    const result = await exec(
      db,
      `delete from api_call_targets
       where id in (
         select t.id
         from api_call_targets t
         where not exists (
           select 1 from api_call_log l where l.target_id = t.id limit 1
         )
         limit 5000
       )`,
    );
    const rows = Number(result.rowsAffected ?? 0);
    if (rows === 0) break;
    pruned += rows;
    await releaseMemory();
  }
  return { pruned };
}

function parseScore(value: unknown): OscScore | null {
  const parsed = parseUnknownJson(value) as Partial<OscScore> | null;
  if (!parsed || !Number.isFinite(parsed.id) || !Number.isFinite(parsed.user_id)) return null;
  return parsed as OscScore;
}

function parseScores(value: unknown): OscScore[] | null {
  const parsed = parseUnknownJson(value);
  if (!Array.isArray(parsed)) return null;
  const scores = parsed.filter((score): score is OscScore => {
    const candidate = score as Partial<OscScore> | null;
    return !!candidate && Number.isFinite(candidate.id) && Number.isFinite(candidate.user_id);
  });
  return scores.length === parsed.length ? scores : null;
}

function compactTopPlayPayload(event: Partial<CountryTopPlay>): Partial<CountryTopPlay> {
  const { user: _user, score, ...rest } = event;
  return {
    ...rest,
    score: score ? compactScoreForStorage(score) : score,
  };
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
