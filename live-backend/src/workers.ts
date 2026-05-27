import type { Db } from "./db.js";
import { readConfig } from "./config.js";
import { canSeedSnipesForCountry } from "./countries.js";
import { exec, json, parseJson } from "./db.js";
import { computeDanEstimateJob } from "./features/dan-estimates.js";
import { MapsRosterNotReadyError, refreshCountryMaps, refreshUserMapsFarmedScores } from "./features/maps.js";
import { updateSnipeProjection } from "./features/snipes.js";
import { confirmTopPlay } from "./features/top-plays.js";
import { getHydratedScoresForMetadata } from "./features/tracker.js";
import type { ClaimOptions, Job, JobQueue } from "./jobs/queue.js";
import type { LiveEventLog } from "./live/event-log.js";
import { OsuApiError, type OsuApiClient } from "./osu/client.js";
import { OscBackfill } from "./osc/backfill.js";
import type { ScoreIngestor } from "./ingest/score-ingestor.js";
import { finishReplayVideoExport, markReplayVideoDoneFromRender, markReplayVideoFailed, markReplayVideoRunning } from "./replay-video/exports.js";
import { renderReplayVideoInChrome, type ServerReplayRenderRequest } from "./replay-video/server-render.js";
import { refreshCountryRoster } from "./rosters/country-rosters.js";
import { getBoardLaneKey, getDisplayedAccuracy, getDisplayedRank, getDisplayedTotalScore, getModAcronyms, getScoreIdentity, getScoreTimestamp, isLazerScore, nowIso, scoreHasReplay } from "./shared/score.js";
import { errorContext, logInfo, logWarn } from "./logger.js";
import type { OscScore } from "./shared/types.js";

interface WorkerLane {
  name: string;
  jobTypes?: string[];
  claimLimit: number;
  intervalMs: number;
}

interface WorkerActiveJob {
  id: number;
  type: string;
  dedupeKey: string;
  attempts: number;
  startedAt: string;
  payload: unknown;
}

const DEFAULT_WORKER_LANES: WorkerLane[] = [
  {
    name: "fast",
    jobTypes: ["refresh_user_top_scores", "refresh_user_maps_farmed_scores", "refresh_country_roster", "enrich_user", "enrich_beatmap", "osc_backfill", "osc_country_catchup", "reconcile_user_recent_scores"],
    claimLimit: 4,
    intervalMs: 750,
  },
  {
    name: "maps-refresh",
    jobTypes: ["refresh_country_maps"],
    claimLimit: 1,
    intervalMs: 1_000,
  },
  {
    name: "dan-estimates",
    jobTypes: ["compute_dan_estimate"],
    claimLimit: 2,
    intervalMs: 1_000,
  },
  {
    name: "snipe-seed",
    jobTypes: ["seed_snipe_board"],
    claimLimit: 1,
    intervalMs: 1_000,
  },
  {
    name: "replay-video-render",
    jobTypes: ["replay_video_server_render"],
    claimLimit: 1,
    intervalMs: 1_000,
  },
  {
    name: "replay-video-finalize",
    jobTypes: ["replay_video_export"],
    claimLimit: 1,
    intervalMs: 1_000,
  },
];

export class WorkerRunner {
  private stopped = false;
  private paused = false;
  private readonly backfill = new OscBackfill(readConfig());
  private readonly activeJobs = new Map<string, WorkerActiveJob[]>();

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
    const activeJob: WorkerActiveJob = {
      id: job.id,
      type: job.type,
      dedupeKey: job.dedupeKey,
      attempts: job.attempts + 1,
      startedAt: nowIso(),
      payload: job.payload,
    };
    this.activeJobs.set(lane, [...(this.activeJobs.get(lane) ?? []), activeJob]);
    try {
      logInfo("job_start", { job_id: job.id, type: job.type, lane, worker_id: workerId, attempts: job.attempts + 1 });
      await this.handle(job);
      await this.queue.complete(job.id);
      logInfo("job_done", { job_id: job.id, type: job.type, lane, worker_id: workerId });
      await this.events.append("job_status", null, { id: job.id, type: job.type, status: "done" }, `job:${job.id}:done:${job.attempts}`);
    } catch (error) {
      if (error instanceof MapsRosterNotReadyError) {
        const retryDelayMs = getRetryDelayMs(job.type, job.attempts, error);
        await this.queue.defer(job.id, retryDelayMs);
        logInfo("job_deferred", { job_id: job.id, type: job.type, lane, worker_id: workerId, retry_delay_ms: retryDelayMs, reason: error.message });
        await this.events.append("job_status", null, { id: job.id, type: job.type, status: "queued", reason: error.message }, `job:${job.id}:deferred:${job.attempts}`);
        return;
      }
      const retryDelayMs = getRetryDelayMs(job.type, job.attempts, error);
      await this.queue.fail(job.id, error, retryDelayMs);
      logWarn("job_failed", { job_id: job.id, type: job.type, lane, worker_id: workerId, retry_delay_ms: retryDelayMs, ...errorContext(error) });
      await this.events.append("job_status", null, { id: job.id, type: job.type, status: "failed" }, `job:${job.id}:failed:${job.attempts}`);
    } finally {
      const remaining = (this.activeJobs.get(lane) ?? []).filter((current) => current.id !== job.id);
      if (remaining.length > 0) {
        this.activeJobs.set(lane, remaining);
      } else {
        this.activeJobs.delete(lane);
      }
    }
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
  }

  status(): { paused: boolean; stopped: boolean; workerId: string; lanes: Array<Omit<WorkerLane, "jobTypes"> & { jobTypes: string[] | null; activeJobs: WorkerActiveJob[] }> } {
    return {
      paused: this.paused,
      stopped: this.stopped,
      workerId: this.workerId,
      lanes: this.lanes.map((lane) => ({
        name: lane.name,
        claimLimit: lane.claimLimit,
        intervalMs: lane.intervalMs,
        jobTypes: lane.jobTypes ?? null,
        activeJobs: this.activeJobs.get(lane.name) ?? [],
      })),
    };
  }

  private async handle(job: Job): Promise<void> {
    if (job.type === "refresh_user_top_scores") {
      await confirmTopPlay(this.db, this.events, this.osu, job.payload as { userId: number; scoreId: number; country: string });
      return;
    }
    if (job.type === "refresh_user_maps_farmed_scores") {
      const result = await refreshUserMapsFarmedScores(this.db, this.osu, job.payload as { userId: number; country: string });
      await this.events.append(
        "maps_farmed_update",
        result.country,
        result,
        `maps_farmed_update:${result.country}:${result.userId}:${result.updatedAt}`,
      );
      return;
    }
    if (job.type === "osc_backfill" || job.type === "osc_country_catchup") {
      const result = await this.backfill.runPage(this.db, this.queue, this.ingestor, job.payload as never);
      await this.events.append("status", null, { type: job.type, ...result }, `${job.type}:${job.id}:${job.attempts}`);
      return;
    }
    if (job.type === "reconcile_user_recent_scores") {
      await this.reconcileUserRecentScores(job.payload as { userId: number });
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
    if (job.type === "compute_dan_estimate") {
      await computeDanEstimateJob(this.db, this.osu, job.payload);
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
      await this.processHydratedScores({ userId: payload.userId });
      return;
    }
    if (job.type === "enrich_beatmap") {
      const payload = job.payload as { beatmapId: number };
      const beatmap = await this.osu.getBeatmap(payload.beatmapId, "job:enrich_beatmap");
      await this.upsertBeatmap(beatmap, payload.beatmapId);
      await this.processHydratedScores({ beatmapId: payload.beatmapId });
      return;
    }
    if (job.type === "seed_snipe_board") {
      const payload = job.payload as { country: string; beatmapId: number; laneKey: string };
      if (!await canSeedSnipesForCountry(this.db, readConfig(), payload.country)) return;
      await this.seedSnipeBoard(payload);
      await this.replaySeededSnipeScores(payload);
      return;
    }
    if (job.type === "replay_video_export") {
      const payload = job.payload as { id: string };
      const config = readConfig();
      const result = await finishReplayVideoExport(this.db, config, payload.id);
      await this.events.append("replay_video_export", null, { id: result.id, status: result.status, url: result.url, error: result.error }, `replay_video_export:${result.id}:${result.status}`);
      return;
    }
    if (job.type === "replay_video_server_render") {
      const payload = job.payload as { id: string; request: ServerReplayRenderRequest };
      const config = readConfig();
      await markReplayVideoRunning(this.db, payload.id);
      try {
        const rendered = await renderReplayVideoInChrome(config, payload.request);
        const result = await markReplayVideoDoneFromRender(this.db, payload.id, rendered);
        await this.events.append("replay_video_export", null, { id: result.id, status: result.status, url: result.url, error: result.error }, `replay_video_export:${result.id}:${result.status}`);
      } catch (error) {
        await markReplayVideoFailed(this.db, payload.id, error);
        throw error;
      }
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

  private async processHydratedScores(filter: { userId?: number; beatmapId?: number }): Promise<void> {
    const rows = await getHydratedScoresForMetadata(this.db, filter);
    for (const row of rows) {
      await this.events.append("tracker_score", row.country, row.score, `tracker_score:${row.country}:${row.score.id}`);
      await this.ingestor.processHydratedSnipeFeatures(row.country, row.score);
    }
  }

  private async replaySeededSnipeScores(payload: { country: string; beatmapId: number; laneKey: string }): Promise<void> {
    const rows = (await getHydratedScoresForMetadata(this.db, { beatmapId: payload.beatmapId }, 200))
      .filter((row) => {
        if (row.country !== payload.country) return false;
        const laneKey = getBoardLaneKey(getModAcronyms(row.score.mods), isLazerScore(row.score));
        return laneKey === payload.laneKey;
      })
      .sort((a, b) => {
        const aTime = new Date(getScoreTimestamp(a.score)).getTime();
        const bTime = new Date(getScoreTimestamp(b.score)).getTime();
        const timeDiff = (Number.isFinite(aTime) ? aTime : 0) - (Number.isFinite(bTime) ? bTime : 0);
        if (timeDiff !== 0) return timeDiff;
        return a.score.id - b.score.id;
      });
    for (const row of rows) {
      await updateSnipeProjection(this.db, this.events, row.country, row.score);
    }
  }

  private async reconcileUserRecentScores(payload: { userId: number }): Promise<void> {
    const userId = Number(payload.userId);
    if (!Number.isFinite(userId) || userId <= 0) return;
    let recentScores: OscScore[];
    try {
      recentScores = await this.osu.getUserRecentScores(userId, "job:reconcile_user_recent_scores");
    } catch (error) {
      if (error instanceof OsuApiError && error.status === 404) {
        logInfo("reconcile_user_recent_scores_missing", { user_id: userId, path: error.path });
        return;
      }
      throw error;
    }
    const scores = recentScores
      .filter((score) => score.passed)
      .map((score) => ({ ...score, ruleset_id: score.ruleset_id ?? 3 }));
    await this.ingestor.ingestBatch(scores, "osu_recent", {
      enqueueRecentReconcile: false,
      processLeaderboardFeatures: false,
    });
    if (await this.isUserActive(userId)) {
      const runAfter = new Date(Date.now() + 2 * 60_000);
      const bucket = Math.floor(runAfter.getTime() / (2 * 60_000));
      await this.queue.enqueue(
        "reconcile_user_recent_scores",
        `recent:user:${userId}:next:${bucket}`,
        { userId },
        { priority: 25, runAfter },
      );
    }
  }

  private async isUserActive(userId: number): Promise<boolean> {
    const cutoff = new Date(Date.now() - 40 * 60_000).toISOString();
    const row = (await exec(
      this.db,
      "select 1 from score_events where user_id = ? and ended_at >= ? limit 1",
      [userId, cutoff],
    )).rows[0];
    return !!row;
  }

  private async seedSnipeBoard(payload: { country: string; beatmapId: number; laneKey: string }): Promise<void> {
    const config = readConfig();
    const replayScoreIdentities = await this.getSeedReplayScoreIdentities(payload);
    const roster = (await exec(
      this.db,
      "select user_id from country_rosters where country = ? and is_tracked = 1 and rank is not null order by rank asc limit ?",
      [payload.country, config.rosterSize],
    )).rows;
    for (const row of roster) {
      const userId = Number(row.user_id);
      const scores = await this.getSnipeSeedScores(payload.beatmapId, userId);
      for (const score of scores) {
        if (replayScoreIdentities.has(getScoreIdentity(score))) continue;
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
            getDisplayedRank(score),
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

  private async getSeedReplayScoreIdentities(payload: { country: string; beatmapId: number; laneKey: string }): Promise<Set<string>> {
    const rows = (await exec(
      this.db,
      `select score_identity, score_id, legacy_score_id, score_json
       from score_events
       where country = ? and beatmap_id = ? and passed = 1`,
      [payload.country, payload.beatmapId],
    )).rows;
    const identities = new Set<string>();
    for (const row of rows) {
      const score = parseJson<OscScore | null>(row.score_json, null);
      if (!score) continue;
      const laneKey = getBoardLaneKey(getModAcronyms(score.mods), isLazerScore(score));
      if (laneKey !== payload.laneKey) continue;
      identities.add(String(row.score_identity));
      const scoreId = Number(row.score_id);
      const legacyScoreId = Number(row.legacy_score_id);
      if (Number.isFinite(scoreId) && scoreId > 0) identities.add(`official:${scoreId}`);
      if (Number.isFinite(legacyScoreId) && legacyScoreId > 0) identities.add(`official:${legacyScoreId}`);
    }
    return identities;
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
  if (error instanceof OsuApiError && error.status === 429) {
    return Math.max(error.retryAfterMs ?? 60_000, 60_000);
  }
  const nextAttempt = Math.max(1, attempts + 1);
  const base = type === "refresh_user_top_scores"
    ? 15_000
    : type === "refresh_user_maps_farmed_scores"
      ? 60_000
    : type === "reconcile_user_recent_scores"
      ? 2 * 60_000
    : type === "osc_backfill" || type === "osc_country_catchup"
      ? 60_000
    : type === "refresh_country_maps"
      ? 10 * 60_000
      : type === "compute_dan_estimate"
        ? 5 * 60_000
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
