import type { Db } from "./db.js";
import { readConfig } from "./config.js";
import { canSeedSnipesForCountry } from "./countries.js";
import { exec, json, parseJson, writeVariantPps } from "./db.js";
import { AVATAR_ACCENT_JOB, computeAvatarAccentJob } from "./features/avatar-accents.js";
import { BEATMAP_OSU_FILE_BACKFILL_JOB, runBeatmapOsuFileBackfillJob } from "./features/beatmap-osu-file-backfill.js";
import { computeBeatmapActivitySkillVector } from "./features/activity.js";
import { CHART_ANALYSIS_BACKFILL_JOB, CHART_ANALYSIS_JOB, CHORDJACK_TAG_RECOMPUTE_JOB, DAN_FLOOR_PIN_RECOMPUTE_JOB, DT_RATE_ANALYSIS_JOB, LN_MSD_SWEEP_JOB, LN_SOURCE_RECOMPUTE_JOB, LN_SUBTYPE_RECOMPUTE_JOB, NOTE_BPM_RECOMPUTE_JOB, VIBRO_RECOMPUTE_JOB, computeBeatmapChartAnalysis, runChartAnalysisBackfillJob, runChordjackTagRecomputeJob, runDanFloorPinRecomputeJob, runDtRateAnalysisJob, runLnMsdSweepJob, runLnSourceRecomputeJob, runLnSubtypeRecomputeJob, runNoteBpmRecomputeJob, runVibroRecomputeJob } from "./features/chart-analysis.js";
import { computeDanEstimateJob } from "./features/dan-estimates.js";
import { reconcileStatGoalsForCountry } from "./features/goals.js";
import { runMapSearchIndexBuildJob } from "./features/map-search.js";
import { rebuildMapCollections } from "./features/map-collections.js";
import { MapsRosterNotReadyError, enqueueGlobalMapsRefresh, globalMapsFarmedRefreshRunAfter, refreshCountryMaps, refreshGlobalMaps, refreshUserMapsFarmedScores } from "./features/maps.js";
import { REFRESH_QUALIFIED_MAPS_JOB, runQualifiedMapsWatch } from "./features/qualified-maps-watch.js";
import { RECONCILE_SETTLED_SETS_JOB, runSettledSetsReconcile } from "./features/settled-sets-reconcile.js";
import { recordSnipeScoreHistory, updateSnipeProjection } from "./features/snipes.js";
import { PLAYER_SKILLS_JOB, computePlayerSkillsJob } from "./features/player-skills.js";
import { SKILL_BASELINE_JOB, runSkillBaselineJob } from "./features/skill-baseline.js";
import { PROFILE_POOL_WARM_JOB, runProfilePoolWarmJob } from "./features/profile-pool-warm.js";
import { confirmTopPlay, TopPlayConfirmationPendingError } from "./features/top-plays.js";
import { getHydratedScoresForMetadata } from "./features/tracker.js";
import type { ClaimOptions, Job, JobQueue } from "./jobs/queue.js";
import { hasPendingRecentReconcileJob, RECENT_RECONCILE_JOB_TYPE, requeueDeferredRecentReconcileJobs } from "./jobs/recent-reconcile.js";
import type { LiveEventLog } from "./live/event-log.js";
import { readWorkersPaused } from "./live/runtime-status.js";
import { OsuApiError, type OsuApiClient } from "./osu/client.js";
import { OscBackfill } from "./osc/backfill.js";
import type { ScoreIngestor } from "./ingest/score-ingestor.js";
import { finishReplayVideoExport, markReplayVideoDoneFromRender, markReplayVideoFailed, markReplayVideoRunning } from "./replay-video/exports.js";
import { renderReplayVideoInChrome, type ServerReplayRenderRequest } from "./replay-video/server-render.js";
import { refreshCountryRoster } from "./rosters/country-rosters.js";
import { getBoardLaneKey, getDisplayedAccuracy, getDisplayedRank, getDisplayedTotalScore, getModAcronyms, getScoreIdentity, getScoreTimestamp, isLazerScore, nowIso, scoreHasReplay } from "./shared/score.js";
import { throwIfAborted } from "./shared/abort.js";
import { errorContext, logInfo, logWarn } from "./logger.js";
import type { OscScore } from "./shared/types.js";
import { markUserMissing } from "./users.js";

interface WorkerLane {
  name: string;
  jobTypes?: string[];
  claimLimit: number;
  intervalMs: number;
  // Watchdog ceiling for a single job invocation; see DEFAULT_JOB_WATCHDOG_MS.
  jobTimeoutMs?: number;
}

// A job whose promise never settles (a starved osu! API slot, a wedged render
// subprocess) would otherwise park its lane forever: the lane tick awaits its
// claimed jobs before scheduling the next claim, and most job types have no
// other consumer to reclaim them. The watchdog rejects the await so the job
// takes the normal fail-with-backoff path and the lane keeps ticking. The
// abandoned promise stays running detached; its eventual settlement is ignored
// (job handlers are idempotent upserts). Jobs are designed short (long work
// self-chains in batches), so ten minutes only ever fires on a genuine hang.
const DEFAULT_JOB_WATCHDOG_MS = 10 * 60_000;

// seed_snipe_board fetches one osu! API page per ranked roster member (rosterSize
// is 100). Seeding all of them in one job means ~100 sequential calls sharing the
// ~45/min budget with every other lane, which routinely blew past the watchdog.
// Each invocation now seeds this many members then self-chains the next batch, so
// a single invocation always finishes well under the watchdog ceiling.
const SNIPE_SEED_ROSTER_BATCH = 15;

export class JobWatchdogTimeoutError extends Error {}

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
    jobTypes: ["refresh_user_top_scores", "refresh_country_roster", "enrich_user", "enrich_beatmap", "reconcile_user_recent_scores"],
    claimLimit: 3,
    intervalMs: 750,
  },
  {
    // Keep global backfill separate and slow so socket outages can be repaired
    // without letting JSON catch-up crowd out interactive enrichment jobs.
    name: "osc-backfill",
    jobTypes: ["osc_backfill"],
    claimLimit: 1,
    intervalMs: 10_000,
  },
  {
    // Reserve one slot for admin-triggered country catch-up without increasing
    // pressure on the fast lane.
    name: "osc-country-catchup",
    jobTypes: ["osc_country_catchup"],
    claimLimit: 1,
    intervalMs: 1_000,
  },
  {
    name: "maps-refresh",
    jobTypes: ["refresh_user_maps_farmed_scores", "refresh_country_maps", "refresh_global_maps", REFRESH_QUALIFIED_MAPS_JOB, RECONCILE_SETTLED_SETS_JOB],
    claimLimit: 1,
    intervalMs: 1_000,
  },
  {
    // Player skill ratings share this lane: both are MinaCalc-bound work and
    // the wasm calls are serialized anyway, so a second lane would not help.
    name: "dan-estimates",
    jobTypes: ["compute_dan_estimate", PLAYER_SKILLS_JOB],
    claimLimit: 2,
    intervalMs: 1_000,
  },
  {
    name: "activity-analysis",
    jobTypes: ["analyze_activity_beatmap"],
    claimLimit: 1,
    intervalMs: 1_500,
  },
  {
    // One CPU-heavy per-beatmap analysis at a time (classifier + MinaCalc,
    // ~0.1-0.3s each). The interval is what sets the 67k-chart backfill pace;
    // the work is local (cached .osu text), no osu! API pressure. Tunable via
    // CHART_ANALYSIS_LANE_INTERVAL_MS so a local backfill can run flat out.
    name: "chart-analysis",
    jobTypes: [CHART_ANALYSIS_JOB, CHART_ANALYSIS_BACKFILL_JOB, VIBRO_RECOMPUTE_JOB, DAN_FLOOR_PIN_RECOMPUTE_JOB, LN_SUBTYPE_RECOMPUTE_JOB, LN_SOURCE_RECOMPUTE_JOB, CHORDJACK_TAG_RECOMPUTE_JOB, DT_RATE_ANALYSIS_JOB, LN_MSD_SWEEP_JOB, NOTE_BPM_RECOMPUTE_JOB],
    claimLimit: 1,
    intervalMs: readConfig().chartAnalysisLaneIntervalMs,
  },
  {
    name: "osu-file-cache",
    jobTypes: [BEATMAP_OSU_FILE_BACKFILL_JOB],
    claimLimit: 1,
    intervalMs: 1_500,
  },
  {
    // Drip-warms profile snapshots for pack-pool players with no stored best
    // scores, so pack reveals never block on a live osu! fetch. Self-chains
    // with a long runAfter; the lane just needs to pick each link up.
    name: "profile-pool-warm",
    jobTypes: [PROFILE_POOL_WARM_JOB],
    claimLimit: 1,
    intervalMs: 5_000,
  },
  {
    name: "snipe-seed",
    jobTypes: ["seed_snipe_board"],
    claimLimit: 1,
    intervalMs: 1_000,
  },
  {
    // Avatar accent extraction: a.ppy.sh CDN fetch + sharp, off the osu! API
    // budget entirely. Its own lane so slow CDN responses never stall the fast
    // enrichment lane.
    name: "avatar-accents",
    jobTypes: [AVATAR_ACCENT_JOB],
    claimLimit: 2,
    intervalMs: 1_000,
  },
  {
    // Renders and finalization legitimately run for many minutes (headless
    // Chrome, ffmpeg mux, R2 upload), so give them a wider watchdog ceiling.
    name: "replay-video-render",
    jobTypes: ["replay_video_server_render"],
    claimLimit: 1,
    intervalMs: 1_000,
    jobTimeoutMs: 45 * 60_000,
  },
  {
    name: "replay-video-finalize",
    jobTypes: ["replay_video_export"],
    claimLimit: 1,
    intervalMs: 1_000,
    jobTimeoutMs: 45 * 60_000,
  },
  {
    // One slow lane for the global map search index build and the collections
    // rebuild. Pure background work (no osu! API) that yields to everything else.
    name: "map-search-index",
    jobTypes: ["build_map_search_index", "rebuild_map_collections"],
    claimLimit: 1,
    intervalMs: 2_000,
  },
  {
    // Weekly approximate-ratings sweep over stored top plays (skill
    // percentile curves). Pure DB/CPU work in self-chaining chunks; its own
    // lane so a long chain never queues behind index maintenance.
    name: "skill-baseline",
    jobTypes: [SKILL_BASELINE_JOB],
    claimLimit: 1,
    intervalMs: 2_000,
  },
];

const OSU_API_JOB_TYPES = new Set([
  "refresh_user_top_scores",
  "refresh_user_maps_farmed_scores",
  "refresh_country_maps",
  "refresh_country_roster",
  "seed_snipe_board",
  "enrich_user",
  "enrich_beatmap",
  "reconcile_user_recent_scores",
  "compute_dan_estimate",
  "analyze_activity_beatmap",
  // CHART_ANALYSIS_JOB and PLAYER_SKILLS_JOB are deliberately absent: both are
  // local CPU work over cached .osu text. They only skip their network fetch
  // fallbacks when osu API jobs are disabled, instead of being skipped
  // wholesale here.
  BEATMAP_OSU_FILE_BACKFILL_JOB,
  PROFILE_POOL_WARM_JOB,
]);

// Admin-monitor superset: every job type whose run consumes osu! API budget,
// including the ones OSU_API_JOB_TYPES leaves runnable when API jobs are
// disabled (their handlers take the osu client but are gated elsewhere).
export const OSU_API_BOUND_JOB_TYPES: ReadonlySet<string> = new Set([
  ...OSU_API_JOB_TYPES,
  REFRESH_QUALIFIED_MAPS_JOB,
  RECONCILE_SETTLED_SETS_JOB,
  "osc_backfill",
  "osc_country_catchup",
]);

export class WorkerRunner {
  private stopped = false;
  private paused = false;
  // Mirror of the cross-process pause flag (control:workers_paused), refreshed
  // on a short interval so an admin "pause" on the serving process takes effect
  // here even when workers run in a separate process.
  private dbPaused = false;
  private dbPausedCheckedAt = 0;
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
    if (await this.isPaused()) return;
    await this.runJobs(this.workerId, await this.claimJobs(this.workerId, 5));
  }

  private async isPaused(): Promise<boolean> {
    if (this.paused) return true;
    const now = Date.now();
    if (now - this.dbPausedCheckedAt > 2_000) {
      this.dbPausedCheckedAt = now;
      this.dbPaused = await readWorkersPaused(this.db).catch(() => this.dbPaused);
    }
    return this.dbPaused;
  }

  private async runLaneOnce(lane: WorkerLane): Promise<void> {
    if (await this.isPaused()) return;
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
    const startedAtMs = Date.now();
    try {
      logInfo("job_start", { job_id: job.id, type: job.type, lane, worker_id: workerId, attempts: job.attempts + 1 });
      await this.handleWithWatchdog(job, lane);
      await this.queue.complete(job.id);
      logInfo("job_done", { job_id: job.id, type: job.type, lane, worker_id: workerId, duration_ms: Date.now() - startedAtMs });
      await this.events.append("job_status", null, { id: job.id, type: job.type, status: "done" }, `job:${job.id}:done:${job.attempts}`);
    } catch (error) {
      if (await this.handleMissingUserJob(workerId, job, lane, error)) return;
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

  private async handleWithWatchdog(job: Job, lane: string): Promise<void> {
    const timeoutMs = this.lanes.find((candidate) => candidate.name === lane)?.jobTimeoutMs ?? DEFAULT_JOB_WATCHDOG_MS;
    const controller = new AbortController();
    // The handler keeps running detached after the watchdog fires (the lane is
    // released so it keeps ticking). Aborting the signal lets handlers that check
    // it stop at their next batch/page boundary instead of running on and burning
    // memory / osu! API budget. Attach a catch so that late (post-timeout) abort
    // rejection from the detached handler is not an unhandled rejection.
    const handlePromise = this.handle(job, controller.signal);
    handlePromise.catch(() => {});
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      await Promise.race([
        handlePromise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            const error = new JobWatchdogTimeoutError(`job watchdog: ${job.type} still running after ${timeoutMs}ms, releasing the lane`);
            // Reject first so the watchdog error is what the race surfaces (the
            // job's fail path / last_error), then abort — a handler that rejects
            // synchronously on abort must not preempt the watchdog message.
            reject(error);
            controller.abort(error);
          }, timeoutMs);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
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
      paused: this.paused || this.dbPaused,
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

  private async handle(job: Job, signal?: AbortSignal): Promise<void> {
    if (!readConfig().enableOsuApiJobs && OSU_API_JOB_TYPES.has(job.type)) {
      logInfo("job_skipped_osu_api_disabled", { job_id: job.id, type: job.type });
      return;
    }
    if (job.type === "refresh_user_top_scores") {
      // Skill recomputes ride the ingest-side session debounce (see
      // score-ingestor.ts), not this confirmation — one compute per session,
      // covering tracked-only sessions too.
      await confirmTopPlay(this.db, this.events, this.osu, job.payload as { userId: number; scoreId: number; country: string });
      return;
    }
    if (job.type === PROFILE_POOL_WARM_JOB) {
      await runProfilePoolWarmJob(this.db, this.queue, this.osu, job.payload as { seq?: number });
      return;
    }
    if (job.type === "refresh_user_maps_farmed_scores") {
      // A single osu! API call plus DB writes: it hit the watchdog only when the
      // shared budget was starved (e.g. by unbatched snipe seeding). Log duration
      // so a regression back into watchdog territory is visible in journald.
      const farmedStartedAt = Date.now();
      const result = await refreshUserMapsFarmedScores(this.db, this.osu, this.queue, job.payload as { userId: number; country: string });
      logInfo("refresh_user_maps_farmed_scores_done", { user_id: result.userId, country: result.country, score_count: result.scoreCount, duration_ms: Date.now() - farmedStartedAt });
      await enqueueGlobalMapsRefresh(this.queue, { priority: 15, replaceDone: true, runAfter: globalMapsFarmedRefreshRunAfter() });
      await this.events.append(
        "maps_farmed_update",
        result.country,
        result,
        `maps_farmed_update:${result.country}:${result.userId}:${result.updatedAt}`,
      );
      return;
    }
    if (job.type === "osc_backfill" || job.type === "osc_country_catchup") {
      const payload = job.payload as Record<string, unknown>;
      const result = await this.backfill.runPage(this.db, this.queue, this.ingestor, {
        ...payload,
        ...(job.type === "osc_backfill" && job.dedupeKey === "osc-backfill:startup" && payload.freshStart !== false ? { freshStart: true } : {}),
      } as never);
      await this.events.append("status", null, { type: job.type, ...result }, `${job.type}:${job.id}:${job.attempts}`);
      return;
    }
    if (job.type === "reconcile_user_recent_scores") {
      await this.reconcileUserRecentScores(job.payload as { userId: number; source?: string; processLeaderboardFeatures?: boolean }, job.id);
      return;
    }
    if (job.type === "refresh_country_roster") {
      const payload = job.payload as { country: string };
      await refreshCountryRoster(this.db, this.osu, payload.country, "job:refresh_country_roster");
      // Fresh pp/rank projections just landed for this roster: settle reach_pp / reach_rank goals
      // now so completion reaches browsers over SSE instead of waiting for a goals-page visit.
      await reconcileStatGoalsForCountry(this.db, this.events, payload.country).catch(() => {});
      return;
    }
    if (job.type === "refresh_country_maps") {
      await refreshCountryMaps(this.db, this.osu, this.queue, job.payload as { country: string });
      await enqueueGlobalMapsRefresh(this.queue, { priority: 15, replaceDone: true });
      return;
    }
    if (job.type === "refresh_global_maps") {
      await refreshGlobalMaps(this.db, signal);
      return;
    }
    if (job.type === REFRESH_QUALIFIED_MAPS_JOB) {
      await runQualifiedMapsWatch(this.db, this.osu, this.queue);
      return;
    }
    if (job.type === RECONCILE_SETTLED_SETS_JOB) {
      await runSettledSetsReconcile(this.db, this.osu, this.queue);
      return;
    }
    if (job.type === "compute_dan_estimate") {
      await computeDanEstimateJob(this.db, this.osu, job.payload);
      return;
    }
    if (job.type === AVATAR_ACCENT_JOB) {
      await computeAvatarAccentJob(this.db, job.payload);
      return;
    }
    if (job.type === "analyze_activity_beatmap") {
      await computeBeatmapActivitySkillVector(this.db, this.osu, job.payload as { beatmapId: number });
      return;
    }
    if (job.type === PLAYER_SKILLS_JOB) {
      await computePlayerSkillsJob(this.db, this.osu, this.queue, job.payload as { userId: number });
      return;
    }
    if (job.type === SKILL_BASELINE_JOB) {
      await runSkillBaselineJob(this.db, this.queue, job.payload as { runId?: string; cursor?: number });
      return;
    }
    if (job.type === CHART_ANALYSIS_JOB) {
      await computeBeatmapChartAnalysis(this.db, this.osu, job.payload as { beatmapId: number });
      return;
    }
    if (job.type === CHART_ANALYSIS_BACKFILL_JOB) {
      await runChartAnalysisBackfillJob(this.db, this.queue, job.payload as { runId?: string; tick?: number });
      return;
    }
    if (job.type === VIBRO_RECOMPUTE_JOB) {
      await runVibroRecomputeJob(this.db, this.queue, job.payload as { cursor?: number });
      return;
    }
    if (job.type === DAN_FLOOR_PIN_RECOMPUTE_JOB) {
      await runDanFloorPinRecomputeJob(this.db, this.queue, job.payload as { cursor?: number });
      return;
    }
    if (job.type === LN_SUBTYPE_RECOMPUTE_JOB) {
      await runLnSubtypeRecomputeJob(this.db, this.queue, job.payload as { cursor?: number });
      return;
    }
    if (job.type === CHORDJACK_TAG_RECOMPUTE_JOB) {
      await runChordjackTagRecomputeJob(this.db, this.queue, job.payload as { cursor?: number });
      return;
    }
    if (job.type === LN_SOURCE_RECOMPUTE_JOB) {
      await runLnSourceRecomputeJob(this.db, this.queue, job.payload as { cursor?: number });
      return;
    }
    if (job.type === DT_RATE_ANALYSIS_JOB) {
      await runDtRateAnalysisJob(this.db, this.queue, job.payload as { cursor?: number });
      return;
    }
    if (job.type === LN_MSD_SWEEP_JOB) {
      await runLnMsdSweepJob(this.db, this.queue, job.payload as { cursor?: number });
      return;
    }
    if (job.type === NOTE_BPM_RECOMPUTE_JOB) {
      await runNoteBpmRecomputeJob(this.db, this.queue, job.payload as { cursor?: number });
      return;
    }
    if (job.type === BEATMAP_OSU_FILE_BACKFILL_JOB) {
      await runBeatmapOsuFileBackfillJob(this.db, this.queue, this.osu, job.payload as { runId: string; cursor?: number });
      return;
    }
    if (job.type === "build_map_search_index") {
      await runMapSearchIndexBuildJob(this.db, this.queue, job.payload as { cursor?: number }, async () => {
        await this.queue.enqueue("rebuild_map_collections", "rebuild_map_collections", {}, { priority: -12, replaceDone: true });
      });
      return;
    }
    if (job.type === "rebuild_map_collections") {
      await rebuildMapCollections(this.db);
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
      await writeVariantPps(this.db, payload.userId, user.statistics);
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
      const payload = job.payload as { country: string; beatmapId: number; laneKey: string; cursor?: number };
      if (!await canSeedSnipesForCountry(this.db, readConfig(), payload.country)) return;
      await this.seedSnipeBoard(payload, signal);
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

  private async handleMissingUserJob(workerId: string, job: Job, lane: string, error: unknown): Promise<boolean> {
    if (!(error instanceof OsuApiError) || error.status !== 404 || !error.path.startsWith("/users/")) return false;
    const userId = Number((job.payload as { userId?: unknown }).userId);
    if (!Number.isInteger(userId) || userId <= 0) return false;
    const result = await markUserMissing(this.db, userId, `${job.type}: ${error.message}`);
    await this.queue.complete(job.id);
    logInfo("job_user_missing", {
      job_id: job.id,
      type: job.type,
      lane,
      worker_id: workerId,
      user_id: userId,
      path: error.path,
      untracked_rosters: result.untrackedRosters,
      deleted_jobs: result.deletedJobs,
    });
    await this.events.append("job_status", null, { id: job.id, type: job.type, status: "done", reason: "user_missing" }, `job:${job.id}:missing:${job.attempts}`);
    return true;
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

  private async replaySeededSnipeScores(payload: { country: string; beatmapId: number; laneKey: string }, signal?: AbortSignal): Promise<void> {
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
      throwIfAborted(signal);
      await updateSnipeProjection(this.db, this.events, row.country, row.score, this.osu);
    }
  }

  private async reconcileUserRecentScores(payload: { userId: number; source?: string; processLeaderboardFeatures?: boolean }, currentJobId?: number): Promise<void> {
    const userId = Number(payload.userId);
    if (!Number.isFinite(userId) || userId <= 0) return;
    const source = payload.source === "osu_recent_fallback" ? "osu_recent_fallback" : "osu_recent";
    const caller = source === "osu_recent_fallback" ? "job:osu_recent_fallback" : "job:reconcile_user_recent_scores";
    let recentScores: OscScore[];
    try {
      recentScores = await this.osu.getUserRecentScores(userId, caller);
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
    await this.ingestor.ingestBatch(scores, source, {
      enqueueRecentReconcile: false,
      processLeaderboardFeatures: payload.processLeaderboardFeatures === true,
    });
    if (await this.isUserActive(userId)) {
      if (await requeueDeferredRecentReconcileJobs(this.db, userId) > 0) return;
      if (await hasPendingRecentReconcileJob(this.db, userId, {
        excludeJobId: currentJobId,
        statuses: ["queued", "failed"],
      })) return;
      const runAfter = new Date(Date.now() + 2 * 60_000);
      const bucket = Math.floor(runAfter.getTime() / (2 * 60_000));
      await this.queue.enqueue(
        RECENT_RECONCILE_JOB_TYPE,
        `recent:user:${userId}:next:${bucket}`,
        { userId },
        { priority: 25, runAfter },
      );
    }
  }

  private async isUserActive(userId: number): Promise<boolean> {
    const cutoff = new Date(Date.now() - 30 * 60_000).toISOString();
    const row = (await exec(
      this.db,
      `select 1
       from score_events
       where user_id = ?
         and ended_at >= ?
         and (source like 'osc_%' or source in ('osu_scores_fallback', 'osu_recent', 'osu_recent_fallback'))
       limit 1`,
      [userId, cutoff],
    )).rows[0];
    return !!row;
  }

  private async seedSnipeBoard(payload: { country: string; beatmapId: number; laneKey: string; cursor?: number }, signal?: AbortSignal): Promise<void> {
    const config = readConfig();
    const rosterSize = Math.max(1, Math.floor(config.rosterSize));
    const cursor = Math.max(0, Math.floor(payload.cursor ?? 0));
    // Seed one bounded batch of ranked roster members per invocation (one osu!
    // API page each), then self-chain the next batch. This keeps every single
    // invocation short enough to finish under the job watchdog even when the
    // osu! budget is contended, instead of doing all ~100 calls in one job.
    const batchSize = Math.min(SNIPE_SEED_ROSTER_BATCH, Math.max(0, rosterSize - cursor));
    const replayScoreIdentities = batchSize > 0 ? await this.getSeedReplayScoreIdentities(payload) : new Set<string>();
    const roster = batchSize > 0
      ? (await exec(
          this.db,
          "select user_id from country_rosters where country = ? and is_tracked = 1 and rank is not null order by rank asc limit ? offset ?",
          [payload.country, batchSize, cursor],
        )).rows
      : [];
    for (const row of roster) {
      throwIfAborted(signal);
      const userId = Number(row.user_id);
      const scores = await this.getSnipeSeedScores(payload.beatmapId, userId);
      await recordSnipeScoreHistory(this.db, payload.country, payload.beatmapId, payload.laneKey, userId, scores, { excludeIdentities: replayScoreIdentities });
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

    const seededThrough = cursor + roster.length;
    const hasMore = roster.length === batchSize && seededThrough < rosterSize;
    logInfo("snipe_seed_batch", {
      country: payload.country,
      beatmap_id: payload.beatmapId,
      lane_key: payload.laneKey,
      from_rank: cursor,
      seeded: roster.length,
      seeded_through: seededThrough,
      has_more: hasMore,
    });
    if (hasMore) {
      // Self-chain the next batch. A distinct dedupe key (the running row would
      // not conflict-update) at a higher priority than a fresh seed so an
      // in-progress board finishes before new boards start. The seed_snipe_board
      // reserved lane parks it until this invocation completes, then reactivates.
      await this.queue.enqueue(
        "seed_snipe_board",
        `snipe-seed:${payload.country}:${payload.beatmapId}:${payload.laneKey}:cursor:${seededThrough}`,
        { country: payload.country, beatmapId: payload.beatmapId, laneKey: payload.laneKey, cursor: seededThrough },
        { priority: 21, replaceDone: true },
      );
      return;
    }
    // Whole roster seeded (or nothing left to seed): replay recorded scores so
    // seeded boards emit any snipe events, then the board is done.
    await this.replaySeededSnipeScores(payload, signal);
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
  if (error instanceof TopPlayConfirmationPendingError) return 2 * 60_000;
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
      : type === "compute_dan_estimate" || type === "analyze_activity_beatmap" || type === CHART_ANALYSIS_JOB
        ? 5 * 60_000
        : type === "enrich_user"
          ? 60_000
          : type === "enrich_beatmap"
            ? 5 * 60_000
            : type === "seed_snipe_board"
              ? 10 * 60_000
              : type === "replay_video_export"
                ? 60_000
              : type === "build_map_search_index"
                ? 60_000
              : type === "rebuild_map_collections"
                ? 5 * 60_000
                : 30 * 60_000;
  return Math.min(base * 2 ** Math.min(5, nextAttempt - 1), 60 * 60_000);
}
