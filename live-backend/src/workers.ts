import type { Db } from "./db.js";
import { readConfig } from "./config.js";
import { exec, json } from "./db.js";
import { refreshCountryMaps } from "./features/maps.js";
import { confirmTopPlay } from "./features/top-plays.js";
import { getHydratedTrackerScoresForMetadata } from "./features/tracker.js";
import type { ClaimOptions, Job, JobQueue } from "./jobs/queue.js";
import type { LiveEventLog } from "./live/event-log.js";
import type { OsuApiClient } from "./osu/client.js";
import { OscBackfill } from "./osc/backfill.js";
import type { ScoreIngestor } from "./ingest/score-ingestor.js";
import { finishReplayVideoExport } from "./replay-video/exports.js";
import { refreshCountryRoster } from "./rosters/country-rosters.js";
import { getBoardLaneKey, getDisplayedAccuracy, getDisplayedTotalScore, getModAcronyms, isLazerScore, nowIso, scoreHasReplay } from "./shared/score.js";
import { errorContext, logInfo, logWarn } from "./logger.js";

interface WorkerLane {
  name: string;
  jobTypes?: string[];
  claimLimit: number;
  intervalMs: number;
}

const DEFAULT_WORKER_LANES: WorkerLane[] = [
  {
    name: "fast",
    jobTypes: ["refresh_user_top_scores", "refresh_country_roster", "refresh_country_maps", "enrich_user", "enrich_beatmap", "osc_backfill"],
    claimLimit: 4,
    intervalMs: 750,
  },
  {
    name: "snipe-seed",
    jobTypes: ["seed_snipe_board"],
    claimLimit: 1,
    intervalMs: 1_000,
  },
  {
    name: "replay-video",
    jobTypes: ["replay_video_export"],
    claimLimit: 1,
    intervalMs: 1_000,
  },
];

export class WorkerRunner {
  private stopped = false;
  private paused = false;
  private readonly backfill = new OscBackfill(readConfig());

  constructor(
    private readonly db: Db,
    private readonly queue: JobQueue,
    private readonly events: LiveEventLog,
    private readonly osu: OsuApiClient,
    private readonly ingestor: ScoreIngestor,
    private readonly workerId = `worker-${process.pid}`,
    private readonly lanes: WorkerLane[] = DEFAULT_WORKER_LANES,
  ) {}

  start(): () => void {
    for (const lane of this.lanes) {
      this.startLane(lane);
    }
    return () => {
      this.stopped = true;
    };
  }

  private startLane(lane: WorkerLane): void {
    const tick = async () => {
      if (this.stopped) return;
      await this.runLaneOnce(lane).catch((error) => console.warn(`[worker:${lane.name}] tick failed`, error));
      if (!this.stopped) setTimeout(tick, lane.intervalMs).unref();
    };
    setTimeout(tick, 0).unref();
  }

  async runOnce(): Promise<void> {
    if (this.paused) return;
    await this.runJobs(this.workerId, await this.claimJobs(this.workerId, 5));
  }

  private async runLaneOnce(lane: WorkerLane): Promise<void> {
    if (this.paused) return;
    const laneWorkerId = `${this.workerId}:${lane.name}`;
    const jobs = await this.claimJobs(laneWorkerId, lane.claimLimit, { types: lane.jobTypes });
    await this.runJobs(laneWorkerId, jobs, lane.name);
  }

  private async claimJobs(workerId: string, limit: number, options?: ClaimOptions): Promise<Job[]> {
    return this.queue.claim(workerId, limit, options);
  }

  private async runJobs(workerId: string, jobs: Job[], lane = "manual"): Promise<void> {
    if (this.paused) return;
    await Promise.all(jobs.map((job) => this.runJob(workerId, job, lane)));
  }

  private async runJob(workerId: string, job: Job, lane: string): Promise<void> {
    if (this.paused) return;
    try {
      logInfo("job_start", { job_id: job.id, type: job.type, lane, worker_id: workerId, attempts: job.attempts + 1 });
      await this.handle(job);
      await this.queue.complete(job.id);
      logInfo("job_done", { job_id: job.id, type: job.type, lane, worker_id: workerId });
      await this.events.append("job_status", null, { id: job.id, type: job.type, status: "done" }, `job:${job.id}:done:${job.attempts}`);
    } catch (error) {
      const retryDelayMs = getRetryDelayMs(job.type, job.attempts, error);
      await this.queue.fail(job.id, error, retryDelayMs);
      logWarn("job_failed", { job_id: job.id, type: job.type, lane, worker_id: workerId, retry_delay_ms: retryDelayMs, ...errorContext(error) });
      await this.events.append("job_status", null, { id: job.id, type: job.type, status: "failed" }, `job:${job.id}:failed:${job.attempts}`);
    }
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
  }

  status(): { paused: boolean; stopped: boolean; workerId: string; lanes: Array<Omit<WorkerLane, "jobTypes"> & { jobTypes: string[] | null }> } {
    return {
      paused: this.paused,
      stopped: this.stopped,
      workerId: this.workerId,
      lanes: this.lanes.map((lane) => ({
        name: lane.name,
        claimLimit: lane.claimLimit,
        intervalMs: lane.intervalMs,
        jobTypes: lane.jobTypes ?? null,
      })),
    };
  }

  private async handle(job: Job): Promise<void> {
    if (job.type === "refresh_user_top_scores") {
      await confirmTopPlay(this.db, this.events, this.osu, job.payload as { userId: number; scoreId: number; country: string });
      return;
    }
    if (job.type === "osc_backfill") {
      const result = await this.backfill.runPage(this.db, this.queue, this.ingestor, job.payload as never);
      await this.events.append("status", null, { type: "osc_backfill", ...result }, `osc_backfill:${job.id}:${job.attempts}`);
      return;
    }
    if (job.type === "refresh_country_roster") {
      const payload = job.payload as { country: string };
      await refreshCountryRoster(this.db, this.osu, payload.country, "job:refresh_country_roster");
      return;
    }
    if (job.type === "refresh_country_maps") {
      await refreshCountryMaps(this.db, this.osu, job.payload as { country: string });
      return;
    }
    if (job.type === "enrich_user") {
      const payload = job.payload as { userId: number };
      const user = await this.osu.getUser(payload.userId, "job:enrich_user");
      await exec(
        this.db,
        `insert into users (user_id, username, avatar_url, country_code, profile_json, updated_at)
         values (?, ?, ?, ?, ?, ?)
         on conflict(user_id) do update set username = excluded.username, avatar_url = excluded.avatar_url, country_code = excluded.country_code, profile_json = excluded.profile_json, updated_at = excluded.updated_at`,
        [payload.userId, String(user.username ?? `User ${payload.userId}`), String(user.avatar_url ?? ""), String(user.country_code ?? ""), json(user), nowIso()],
      );
      await this.emitHydratedTrackerScores({ userId: payload.userId });
      return;
    }
    if (job.type === "enrich_beatmap") {
      const payload = job.payload as { beatmapId: number };
      const beatmap = await this.osu.getBeatmap(payload.beatmapId, "job:enrich_beatmap");
      await this.upsertBeatmap(beatmap, payload.beatmapId);
      await this.emitHydratedTrackerScores({ beatmapId: payload.beatmapId });
      return;
    }
    if (job.type === "seed_snipe_board") {
      await this.seedSnipeBoard(job.payload as { country: string; beatmapId: number; laneKey: string });
      return;
    }
    if (job.type === "replay_video_export") {
      const payload = job.payload as { id: string };
      const config = readConfig();
      const result = await finishReplayVideoExport(this.db, config, payload.id);
      await this.events.append("replay_video_export", null, { id: result.id, status: result.status, url: result.url, error: result.error }, `replay_video_export:${result.id}:${result.status}`);
      return;
    }
    throw new Error(`Unknown job type: ${job.type}`);
  }

  private async upsertBeatmap(raw: Record<string, unknown>, beatmapId: number): Promise<void> {
    const beatmapset = raw.beatmapset as Record<string, unknown> | undefined;
    const beatmapsetId = Number(raw.beatmapset_id ?? beatmapset?.id ?? 0);
    const now = nowIso();
    if (beatmapset && beatmapsetId > 0) {
      await exec(
        this.db,
        `insert into beatmapsets (beatmapset_id, title, artist, creator, status, covers_json, metadata_json, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?)
         on conflict(beatmapset_id) do update set title = excluded.title, artist = excluded.artist, covers_json = excluded.covers_json, metadata_json = excluded.metadata_json, updated_at = excluded.updated_at`,
        [
          beatmapsetId,
          String(beatmapset.title ?? ""),
          String(beatmapset.artist ?? ""),
          beatmapset.creator == null ? null : String(beatmapset.creator),
          raw.status == null ? null : String(raw.status),
          json(beatmapset.covers ?? {}),
          json(beatmapset),
          now,
        ],
      );
    }
    await exec(
      this.db,
      `insert into beatmaps (beatmap_id, beatmapset_id, mode, status, cs, difficulty_rating, bpm, max_combo, version, url, metadata_json, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       on conflict(beatmap_id) do update set metadata_json = excluded.metadata_json, version = excluded.version, updated_at = excluded.updated_at`,
      [
        beatmapId,
        beatmapsetId,
        String(raw.mode ?? "mania"),
        raw.status == null ? null : String(raw.status),
        Number(raw.cs ?? 0),
        Number(raw.difficulty_rating ?? 0),
        Number(raw.bpm ?? 0),
        raw.max_combo == null ? null : Number(raw.max_combo),
        String(raw.version ?? ""),
        String(raw.url ?? `https://osu.ppy.sh/beatmaps/${beatmapId}`),
        json(raw),
        now,
      ],
    );
  }

  private async emitHydratedTrackerScores(filter: { userId?: number; beatmapId?: number }): Promise<void> {
    const rows = await getHydratedTrackerScoresForMetadata(this.db, filter);
    for (const row of rows) {
      await this.events.append("tracker_score", row.country, row.score, `tracker_score:${row.country}:${row.score.id}`);
    }
  }

  private async seedSnipeBoard(payload: { country: string; beatmapId: number; laneKey: string }): Promise<void> {
    const config = readConfig();
    const roster = (await exec(this.db, "select user_id from country_rosters where country = ? and is_tracked = 1 order by rank asc limit ?", [payload.country, config.rosterSize])).rows;
    for (const row of roster) {
      const userId = Number(row.user_id);
      const scores = await this.getSnipeSeedScores(payload.beatmapId, userId);
      for (const score of scores) {
        const totalScore = getDisplayedTotalScore(score);
        if (totalScore == null) continue;
        const laneKey = getBoardLaneKey(getModAcronyms(score.mods), isLazerScore(score));
        if (laneKey !== payload.laneKey) continue;
        await exec(
          this.db,
          `insert into country_beatmap_scores (country, beatmap_id, lane_key, user_id, score_id, total_score, pp, accuracy, rank, mods_json, is_lazer, has_replay, ended_at, updated_at)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           on conflict(country, beatmap_id, lane_key, user_id) do update set
             score_id = excluded.score_id,
             total_score = excluded.total_score,
             pp = excluded.pp,
             accuracy = excluded.accuracy,
             rank = excluded.rank,
             mods_json = excluded.mods_json,
             is_lazer = excluded.is_lazer,
             has_replay = excluded.has_replay,
             ended_at = excluded.ended_at,
             updated_at = excluded.updated_at
           where excluded.total_score > country_beatmap_scores.total_score`,
          [
            payload.country,
            payload.beatmapId,
            payload.laneKey,
            score.user_id,
            score.id,
            totalScore,
            score.pp,
            getDisplayedAccuracy(score),
            score.rank,
            json(getModAcronyms(score.mods)),
            isLazerScore(score) ? 1 : 0,
            scoreHasReplay(score) ? 1 : 0,
            score.ended_at ?? score.created_at ?? nowIso(),
            nowIso(),
          ],
        );
      }
    }
  }

  private async getSnipeSeedScores(beatmapId: number, userId: number) {
    try {
      return await this.osu.getBeatmapUserScoresAll(beatmapId, userId, "job:seed_snipe_board");
    } catch (error) {
      if (error instanceof Error && error.message.includes("osu! API 404")) {
        logInfo("snipe_seed_user_scores_missing", { beatmap_id: beatmapId, user_id: userId });
        return [];
      }
      throw error;
    }
  }
}

function getRetryDelayMs(type: string, attempts: number, error: unknown): number {
  if (error instanceof Error && error.message.includes("OSU_CLIENT_ID")) return 5 * 60_000;
  const nextAttempt = Math.max(1, attempts + 1);
  const base = type === "refresh_user_top_scores"
    ? 15_000
    : type === "osc_backfill"
      ? 60_000
    : type === "refresh_country_maps"
      ? 10 * 60_000
    : type === "enrich_user"
      ? 60_000
      : type === "enrich_beatmap"
        ? 5 * 60_000
        : type === "seed_snipe_board"
          ? 10 * 60_000
          : type === "replay_video_export"
            ? 60_000
          : 30 * 60_000;
  return Math.min(base * 2 ** Math.min(5, nextAttempt - 1), 60 * 60_000);
}
