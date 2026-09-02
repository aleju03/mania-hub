import type { Config } from "../config.js";
import type { Db } from "../db.js";
import { exec, withWriteTurn } from "../db.js";
import { ScoreIngestor } from "../ingest/score-ingestor.js";
import type { JobQueue } from "../jobs/queue.js";
import type { LiveEventLog } from "../live/event-log.js";
import { logInfo } from "../logger.js";
import { OsuApiError, type OsuApiClient } from "../osu/client.js";
import { getScoreIdentity, nowIso } from "../shared/score.js";
import type { OscScore, OsuBeatmap, OsuBeatmapset } from "../shared/types.js";

/**
 * Leaderboard import: an admin picks a ranked or loved chart and its whole
 * global leaderboard (the top 50 osu! publishes, there is no page two) goes
 * through the same ScoreIngestor call a manual submission takes. The ingest
 * gates are untouched: a score only lands under a country the site tracks,
 * so a board full of players from cold countries mostly reports "untracked",
 * and what a stored play earns is decided downstream like any other.
 *
 * Admin-only for now because every run spends two osu! requests per chart
 * and can write fifty rows; the plumbing is deliberately the ordinary one so
 * opening it up later is a permission change, not a rewrite. The route only
 * enqueues; the worker's leaderboard-import lane runs importBeatmapLeaderboard.
 */

export const LEADERBOARD_IMPORT_SOURCE = "leaderboard_import";
export const LEADERBOARD_IMPORT_JOB = "import_beatmap_leaderboard";
export const LEADERBOARD_IMPORT_COOLDOWN_DAYS = 7;
export const LEADERBOARD_IMPORT_COOLDOWN_MS = LEADERBOARD_IMPORT_COOLDOWN_DAYS * 24 * 60 * 60 * 1_000;

export function leaderboardImportDedupeKey(beatmapId: number): string {
  return `leaderboard-import:${beatmapId}`;
}

/* The route enqueues and answers at once: an admin importing a hundred boards
   in a row must not hold a hundred osu! round-trips open, and the queue's
   dedicated lane paces them. A durable successful-import receipt guards the
   seven-day cooldown; replaceDone only lets a chart run again after that. */
export async function enqueueLeaderboardImport(db: Db, queue: JobQueue, beatmapId: number): Promise<"queued" | "recent"> {
  const [status] = await getLeaderboardImportStatuses(db, [beatmapId]);
  if (status?.recent) return "recent";
  await queue.enqueue(LEADERBOARD_IMPORT_JOB, leaderboardImportDedupeKey(beatmapId), { beatmapId }, { priority: 60, replaceDone: true });
  return "queued";
}

export type LeaderboardImportJobStatus = "queued" | "running" | "done" | "failed" | "none";

export interface LeaderboardImportStatus {
  beatmapId: number;
  status: LeaderboardImportJobStatus;
  error: string | null;
  // Rows still retained from imports, falling back to the latest durable
  // receipt after raw score-event retention has removed them.
  stored: number;
  // Successful imports get a seven-day cooldown. Job rows only live for two
  // days, so this timestamp comes from durable history, with score_events and
  // an extant done job as rollout fallbacks for imports made before the table.
  lastImportedAt: string | null;
  retryAt: string | null;
  recent: boolean;
}

// `journalDb` is the journal database (journal.ts), where the osu! call log
// lives; tests that keep every table in one file leave it defaulted.
export async function getLeaderboardImportStatuses(db: Db, beatmapIds: number[], journalDb: Db = db): Promise<LeaderboardImportStatus[]> {
  const ids = [...new Set(beatmapIds.filter((id) => Number.isInteger(id) && id > 0))];
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(", ");
  const dedupeKeys = ids.map(leaderboardImportDedupeKey);
  const boardPaths = ids.map((beatmapId) => `/beatmaps/${beatmapId}/scores?mode=mania`);
  const [jobRows, eventRows, historyRows, apiRows] = await Promise.all([
    exec(db, `select dedupe_key, status, last_error, updated_at from jobs where dedupe_key in (${placeholders})`, dedupeKeys),
    exec(
      db,
      `select beatmap_id, count(*) as cnt, max(received_at) as last_imported_at
       from score_events
       where source = ? and beatmap_id in (${placeholders})
       group by beatmap_id`,
      [LEADERBOARD_IMPORT_SOURCE, ...ids],
    ),
    exec(
      db,
      `select beatmap_id, last_imported_at, last_stored
       from leaderboard_import_history
       where beatmap_id in (${placeholders})`,
      ids,
    ),
    exec(
      journalDb,
      `select t.path, max(l.started_at) as last_imported_at
       from api_call_targets t
       join api_call_log l on l.target_id = t.id
       where t.provider = 'osu'
         and t.caller = ?
         and t.path in (${placeholders})
         and l.status between 200 and 299
       group by t.path`,
      ["leaderboard-import", ...boardPaths],
    ),
  ]);
  const jobs = new Map(jobRows.rows.map((row) => [String(row.dedupe_key), row]));
  const events = new Map(eventRows.rows.map((row) => [Number(row.beatmap_id), row]));
  const history = new Map(historyRows.rows.map((row) => [Number(row.beatmap_id), row]));
  const apiCalls = new Map(apiRows.rows.map((row) => [String(row.path), row]));
  const now = Date.now();
  return ids.map((beatmapId) => {
    const job = jobs.get(leaderboardImportDedupeKey(beatmapId));
    const retained = events.get(beatmapId);
    const receipt = history.get(beatmapId);
    const apiCall = apiCalls.get(`/beatmaps/${beatmapId}/scores?mode=mania`);
    const raw = job ? String(job.status) : "none";
    const status: LeaderboardImportJobStatus = raw === "deferred_pressure" ? "queued"
      : raw === "queued" || raw === "running" || raw === "done" || raw === "failed" ? raw
        : "none";
    const candidates = [
      receipt?.last_imported_at,
      // A retained row is rollout evidence only when no unfinished job exists.
      // If a worker crashed halfway through a board, its first stored score
      // must not make that partial run look complete and suppress the retry.
      status === "none" || status === "done" ? retained?.last_imported_at : null,
      // The successful top-50 request covers pre-history imports that stored no
      // rows because every player was already known or from an untracked
      // country. As above, an unfinished job wins over this rollout fallback.
      status === "none" || status === "done" ? apiCall?.last_imported_at : null,
      status === "done" ? job?.updated_at : null,
    ]
      .map((value) => value == null ? null : String(value))
      .filter((value): value is string => value != null && Number.isFinite(Date.parse(value)));
    const lastImportedAt = candidates.sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null;
    const retryAt = lastImportedAt ? new Date(Date.parse(lastImportedAt) + LEADERBOARD_IMPORT_COOLDOWN_MS).toISOString() : null;
    return {
      beatmapId,
      status,
      error: status === "failed" && job?.last_error != null ? String(job.last_error) : null,
      stored: Math.max(Number(retained?.cnt ?? 0), Number(receipt?.last_stored ?? 0)),
      lastImportedAt,
      retryAt,
      recent: retryAt != null && Date.parse(retryAt) > now,
    };
  });
}

// Statuses osu! keeps a leaderboard for. Qualified boards exist but get wiped
// on rank, so they are not worth a row; the dialog only searches ranked/loved.
const LEADERBOARD_STATUSES = new Set(["ranked", "approved", "loved"]);

export type LeaderboardImportFailure = "beatmap_not_found" | "not_mania" | "no_leaderboard";

export type LeaderboardImportOutcome = "stored" | "already_tracked" | "untracked";

export interface LeaderboardImportPlayer {
  userId: number;
  username: string | null;
  country: string | null;
  accuracy: number | null;
  outcome: LeaderboardImportOutcome;
}

export interface LeaderboardImportChart {
  beatmapId: number;
  beatmapsetId: number;
  title: string;
  artist: string;
  version: string;
  keyCount: number;
  status: string;
}

export type LeaderboardImportResult =
  | {
    ok: true;
    chart: LeaderboardImportChart;
    fetched: number;
    stored: number;
    alreadyTracked: number;
    untracked: number;
    players: LeaderboardImportPlayer[];
  }
  | { ok: false; reason: LeaderboardImportFailure };

export async function importBeatmapLeaderboard(
  db: Db,
  queue: JobQueue,
  events: LiveEventLog,
  config: Config,
  osu: OsuApiClient,
  beatmapId: number,
): Promise<LeaderboardImportResult> {
  let fetched: Record<string, unknown>;
  try {
    fetched = await osu.getBeatmap(beatmapId, "leaderboard-import");
  } catch (error) {
    if (error instanceof OsuApiError && error.status === 404) return { ok: false, reason: "beatmap_not_found" };
    throw error;
  }
  const { beatmapset: rawSet, ...rawBeatmap } = fetched as Record<string, unknown> & { beatmapset?: OsuBeatmapset };
  const beatmap = rawBeatmap as unknown as OsuBeatmap;
  if (beatmap.mode !== "mania" && Number((fetched as { mode_int?: unknown }).mode_int) !== 3) {
    return { ok: false, reason: "not_mania" };
  }
  const status = String(beatmap.status ?? rawSet?.status ?? "");
  if (!LEADERBOARD_STATUSES.has(status)) return { ok: false, reason: "no_leaderboard" };
  const beatmapset = rawSet ?? null;

  const board = await osu.getBeatmapScores(beatmapId, "leaderboard-import");
  const scores: OscScore[] = board
    .filter((score) => score && Number(score.ruleset_id ?? 3) === 3 && score.passed !== false)
    .map((score) => ({
      ...score,
      ruleset_id: 3,
      beatmap_id: beatmapId,
      beatmap,
      ...(beatmapset ? { beatmapset } : {}),
    }));

  const ingestor = new ScoreIngestor(db, queue, events, config);
  const players: LeaderboardImportPlayer[] = [];
  let stored = 0;
  let alreadyTracked = 0;
  let untracked = 0;
  for (const score of scores) {
    const identity = getScoreIdentity(score);
    const known = (await exec(db, "select 1 from score_events where score_identity = ? limit 1", [identity])).rows;
    let outcome: LeaderboardImportOutcome;
    if (known.length > 0) {
      outcome = "already_tracked";
      alreadyTracked++;
    } else {
      // Same historical-ingest shape as a manual submission (see
      // score-submissions.ts for why each surface is off): boards and
      // ratings may move, nothing may look like it just happened. One write
      // turn per score rather than one for the board, so a fifty-row import
      // interleaves with pack draws instead of holding the lock for all of it.
      const result = await withWriteTurn(db, () => ingestor.ingestBatch([score], LEADERBOARD_IMPORT_SOURCE, {
        enqueueRecentReconcile: false,
        processGoalFeatures: false,
        processTopPlayFeatures: false,
        suppressSnipeEvents: true,
        suppressTrackerEvents: true,
      }));
      if (result.inserted > 0) {
        outcome = "stored";
        stored++;
      } else {
        outcome = "untracked";
        untracked++;
      }
    }
    players.push({
      userId: Number(score.user_id),
      username: score.user?.username ?? null,
      country: score.user?.country_code?.toUpperCase() ?? null,
      accuracy: Number.isFinite(score.accuracy) ? score.accuracy : null,
      outcome,
    });
  }
  // The skill recomputes ride the session-debounced enqueue the ingest
  // already did; nobody is watching one profile here, so nothing is yanked
  // forward the way a manual submission is.
  const importedAt = nowIso();
  await withWriteTurn(db, () => exec(
    db,
    `insert into leaderboard_import_history
       (beatmap_id, last_imported_at, last_fetched, last_stored, last_already_tracked, last_untracked)
     values (?, ?, ?, ?, ?, ?)
     on conflict(beatmap_id) do update set
       last_imported_at = excluded.last_imported_at,
       last_fetched = excluded.last_fetched,
       last_stored = excluded.last_stored,
       last_already_tracked = excluded.last_already_tracked,
       last_untracked = excluded.last_untracked`,
    [beatmapId, importedAt, scores.length, stored, alreadyTracked, untracked],
  ));
  logInfo("leaderboard_imported", {
    beatmap_id: beatmapId,
    fetched: scores.length,
    stored,
    already_tracked: alreadyTracked,
    untracked,
  });
  return {
    ok: true,
    chart: {
      beatmapId,
      beatmapsetId: Number(beatmap.beatmapset_id ?? beatmapset?.id ?? 0),
      title: beatmapset?.title ?? "",
      artist: beatmapset?.artist ?? "",
      version: beatmap.version ?? "",
      keyCount: Number(beatmap.cs ?? 0),
      status,
    },
    fetched: scores.length,
    stored,
    alreadyTracked,
    untracked,
    players,
  };
}
