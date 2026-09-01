import type { Config } from "../config.js";
import type { Db } from "../db.js";
import { exec, withWriteTurn } from "../db.js";
import { ScoreIngestor } from "../ingest/score-ingestor.js";
import type { JobQueue } from "../jobs/queue.js";
import type { LiveEventLog } from "../live/event-log.js";
import { logInfo } from "../logger.js";
import { OsuApiError, type OsuApiClient } from "../osu/client.js";
import { getScoreIdentity } from "../shared/score.js";
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

export function leaderboardImportDedupeKey(beatmapId: number): string {
  return `leaderboard-import:${beatmapId}`;
}

/* The route enqueues and answers at once: an admin importing a hundred boards
   in a row must not hold a hundred osu! round-trips open, and the queue's
   dedicated lane paces them. replaceDone so a repeat import of the same chart
   runs again (it re-reads the board; already-stored scores are skipped). */
export async function enqueueLeaderboardImport(queue: JobQueue, beatmapId: number): Promise<void> {
  await queue.enqueue(LEADERBOARD_IMPORT_JOB, leaderboardImportDedupeKey(beatmapId), { beatmapId }, { priority: 60, replaceDone: true });
}

export type LeaderboardImportJobStatus = "queued" | "running" | "done" | "failed" | "none";

export interface LeaderboardImportStatus {
  beatmapId: number;
  status: LeaderboardImportJobStatus;
  error: string | null;
  // Rows this chart has from imports so far, all runs included. The queue
  // keeps no per-job result, and this is the one number an admin waits for.
  stored: number;
}

export async function getLeaderboardImportStatuses(db: Db, beatmapIds: number[]): Promise<LeaderboardImportStatus[]> {
  const out: LeaderboardImportStatus[] = [];
  for (const beatmapId of beatmapIds) {
    const job = (await exec(db, "select status, last_error from jobs where dedupe_key = ?", [leaderboardImportDedupeKey(beatmapId)])).rows[0];
    const stored = (await exec(
      db,
      "select count(*) as cnt from score_events where beatmap_id = ? and source = ?",
      [beatmapId, LEADERBOARD_IMPORT_SOURCE],
    )).rows[0];
    const raw = job ? String(job.status) : "none";
    const status: LeaderboardImportJobStatus = raw === "deferred_pressure" ? "queued"
      : raw === "queued" || raw === "running" || raw === "done" || raw === "failed" ? raw
        : "none";
    out.push({
      beatmapId,
      status,
      error: status === "failed" && job?.last_error != null ? String(job.last_error) : null,
      stored: Number(stored?.cnt ?? 0),
    });
  }
  return out;
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
