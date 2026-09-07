import { CHART_FAMILY_SWEEP_JOB, runChartFamilySweepJob } from "./features/chart-families.js";
import type { Db } from "./db.js";
import { readConfig } from "./config.js";
import { canSeedSnipesForCountry, isCountryRosterConfirmedEmpty, retireCountry } from "./countries.js";
import { exec, json, parseJson } from "./db.js";
import { AVATAR_ACCENT_JOB, computeAvatarAccentJob } from "./features/avatar-accents.js";
import { BEATMAP_OSU_FILE_BACKFILL_JOB, runBeatmapOsuFileBackfillJob } from "./features/beatmap-osu-file-backfill.js";
import { ACTIVITY_BACKFILL_JOB, computeBeatmapActivitySkillVector, runPlayerActivityBackfillJob } from "./features/activity.js";
import { BRACKET_CONTENT_RECOMPUTE_JOB, BRACKET_TAG_RECOMPUTE_JOB, CHART_ANALYSIS_BACKFILL_JOB, CHART_ANALYSIS_JOB, CHORDJACK_TAG_RECOMPUTE_JOB, COMPANELLA_RECOMPUTE_JOB, DAN_ELIGIBILITY_RECOMPUTE_JOB, DAN_FLOOR_PIN_RECOMPUTE_JOB, DT_RATE_ANALYSIS_JOB, HT_RATE_ANALYSIS_JOB, INVERSE_CLUSTER_BPM_JOB, JACK_DEMAND_RECOMPUTE_JOB, NKEY_MSD_JOB, JACK_TAG_RECOMPUTE_JOB, MOTION_FEATURES_RECOMPUTE_JOB, LEOBLACK_REPIN_DT_RECOMPUTE_JOB, LEOBLACK_REPIN_RECOMPUTE_JOB, LN_MSD_SWEEP_JOB, LN_LEOBLACK_RECOMPUTE_JOB, LN_PRIMARY_REPIN_JOB, LN7_PRIMARY_REPIN_JOB, LN_SOURCE_RECOMPUTE_JOB, LN_SUBTYPE_RECOMPUTE_JOB, MSD_POISON_RECOVERY_JOB, NOTE_BPM_RECOMPUTE_JOB, OSU_FILE_REPAIR_JOB, SUNNY_REPIN_DT_RECOMPUTE_JOB, SUNNY_REPIN_RECOMPUTE_JOB, VIBRO_RECOMPUTE_JOB, computeBeatmapChartAnalysis, runBracketContentRecomputeJob, runBracketTagRecomputeJob, runChartAnalysisBackfillJob, runChordjackTagRecomputeJob, runCompanellaRecomputeJob, runDanEligibilityRecomputeJob, runDanFloorPinRecomputeJob, runDtRateAnalysisJob, runHtRateAnalysisJob, runInverseClusterBpmRecoveryJob, runJackDemandRecomputeJob, runNkeyMsdJob, runJackTagRecomputeJob, runMotionFeaturesRecomputeJob, runLeoblackRepinDtRecomputeJob, runLeoblackRepinRecomputeJob, runLnLeoblackRecomputeJob, runLnMsdSweepJob, runLn7PrimaryRepinJob, runLnPrimaryRepinJob, runLnSourceRecomputeJob, runLnSubtypeRecomputeJob, runMsdPoisonRecoveryJob, runNoteBpmRecomputeJob, runOsuFileRepairJob, runSunnyRepinDtRecomputeJob, runSunnyRepinRecomputeJob, runVibroRecomputeJob } from "./features/chart-analysis.js";
import { computeDanEstimateJob } from "./features/dan-estimates.js";
import { reconcileGoalsForUser, reconcileStatGoalsForCountry } from "./features/goals.js";
import { runMapSearchIndexBuildJob, upsertMapSearchIndexRow } from "./features/map-search.js";
import { rebuildMapCollections } from "./features/map-collections.js";
import { LEADERBOARD_IMPORT_JOB, getLeaderboardImportStatuses, importBeatmapLeaderboard } from "./features/leaderboard-import.js";
import { GLOBAL_FARMED_BOARD_REPACK_JOB, MapsEmptyResultError, MapsRosterNotReadyError, enqueueGlobalMapsRefresh, globalMapsRefreshRunAfter, refreshCountryMaps, refreshGlobalMaps, refreshUserMapsFarmedScores, runGlobalFarmedBoardRepackJob } from "./features/maps.js";
import { REFRESH_QUALIFIED_MAPS_JOB, runQualifiedMapsWatch } from "./features/qualified-maps-watch.js";
import { RECONCILE_SETTLED_SETS_JOB, runSettledSetsReconcile } from "./features/settled-sets-reconcile.js";
import { recordSnipeScoreHistory, updateSnipeProjection } from "./features/snipes.js";
import { PLAYER_SKILLS_JOB, PLAYER_SKILL_DAN_SWEEP_JOB, PLAYER_SKILL_FLOOR_SWEEP_JOB, PLAYER_SKILL_MSD_CAP_JOB, PLAYER_SKILL_PATTERN_SWEEP_JOB, PLAYER_SKILL_POISON_JOB, PLAYER_SKILL_VIBRO_SWEEP_JOB, computePlayerSkillsJob, ensurePlayerSkillDanSweepSeeded, ensurePlayerSkillPatternSweepSeeded, runPlayerSkillDanSweepJob, runPlayerSkillFloorSweepJob, runPlayerSkillMsdCapSweepJob, runPlayerSkillPatternSweepJob, runPlayerSkillPoisonRecoveryJob, runPlayerSkillVibroSweepJob, type PlayerSkillDanSweepPayload } from "./features/player-skills.js";
import { SKILL_VECTOR_BACKFILL_JOB, runSkillVectorBackfillJob } from "./features/skill-vector-backfill.js";
import { SKILL_BASELINE_JOB, enqueueSkillBaselineIfDue, runSkillBaselineJob } from "./features/skill-baseline.js";
import { PROFILE_POOL_WARM_JOB, runProfilePoolWarmJob } from "./features/profile-pool-warm.js";
import { PROFILE_SNAPSHOT_REFRESH_JOB, PROFILE_USER_REFRESH_JOB, runProfileSnapshotRefreshJob, runProfileUserRefreshJob, upsertDisplayUser } from "./features/player-profiles.js";
import { confirmTopPlay, TopPlayConfirmationPendingError } from "./features/top-plays.js";
import { TOP_SCORES_BACKFILL_JOB, runTopScoresBackfillJob } from "./features/top-scores-backfill.js";
import { ACTIVITY_MODS_BACKFILL_JOB_TYPE, runActivityModsBackfillJob } from "./features/activity-mods-backfill.js";
import { ACTIVITY_COMBO_BACKFILL_JOB_TYPE, runActivityComboBackfillJob } from "./features/activity-combo-backfill.js";
import { ACTIVITY_DETAIL_ON_DEMAND_JOB, runActivityDetailOnDemandJob } from "./features/activity-detail-on-demand.js";
import { getHydratedScoresForMetadata } from "./features/tracker.js";
import type { ClaimOptions, Job, JobQueue } from "./jobs/queue.js";
import { JobLeaseLostError, maintainJobLease } from "./jobs/lease.js";
import { hasPendingRecentReconcileJob, nextRecentReconcileCadence, RECENT_RECONCILE_JOB_TYPE, requeueDeferredRecentReconcileJobs, type RecentReconcilePayload } from "./jobs/recent-reconcile.js";
import type { LiveEventLog } from "./live/event-log.js";
import { readWorkersPaused, writeJobMemoryMetric } from "./live/runtime-status.js";
import { OsuApiError, type OsuApiClient } from "./osu/client.js";
import { OscBackfill } from "./osc/backfill.js";
import type { ScoreIngestor } from "./ingest/score-ingestor.js";
import { finishReplayVideoExport, markReplayVideoDoneFromRender, markReplayVideoFailed, markReplayVideoRunning } from "./replay-video/exports.js";
import { renderReplayVideoInChrome, type ServerReplayRenderRequest } from "./replay-video/server-render.js";
import { refreshCountryRoster } from "./rosters/country-rosters.js";
import { getBoardLaneKey, getDisplayedAccuracy, getDisplayedRank, getDisplayedTotalScore, getModAcronyms, getScoreIdentity, getScoreTimestamp, isLazerScore, nowIso, scoreHasReplay } from "./shared/score.js";
import { throwIfAborted } from "./shared/abort.js";
import { startPeakMemorySampler } from "./shared/process-memory.js";
import { errorContext, logInfo, logWarn } from "./logger.js";
import type { OscScore } from "./shared/types.js";
import { markUserMissing } from "./users.js";
import { isUserKnownInactive } from "./user-status.js";

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
// other consumer to reclaim them. The watchdog releases the lane and aborts
// the handler. Its lease remains live until that handler settles, then it
// takes the fail-with-backoff path; an uncooperative handler cannot overlap a
// retry. Aborting attempts stay visible in worker status. Jobs are short (long work
// self-chains in batches), so ten minutes only ever fires on a genuine hang.
const DEFAULT_JOB_WATCHDOG_MS = 10 * 60_000;

// seed_snipe_board fetches one osu! API page per ranked roster member (rosterSize
// is 100). Seeding all of them in one job means ~100 sequential calls sharing the
// ~45/min budget with every other lane, which routinely blew past the watchdog.
// Each invocation now seeds this many members then self-chains the next batch, so
// a single invocation always finishes well under the watchdog ceiling.
const SNIPE_SEED_ROSTER_BATCH = 15;

export class JobWatchdogTimeoutError extends Error {
  settled?: Promise<void>;
}

class DeferredJobError extends Error {
  constructor(readonly delayMs: number) { super("bounded job batch completed; continuation pending"); }
}

interface WorkerActiveJob {
  id: number;
  type: string;
  dedupeKey: string;
  attempts: number;
  startedAt: string;
  payload: unknown;
  aborting?: boolean;
}

class LeaderboardImportRefusedError extends Error {
  constructor(reason: string) {
    super(`leaderboard import refused: ${reason}`);
    this.name = "LeaderboardImportRefusedError";
  }
}

const REPLAY_VIDEO_JOB_TYPES = new Set(["replay_video_server_render", "replay_video_export"]);
const REPLAY_VIDEO_LANE_NAMES = new Set(["replay-video-render", "replay-video-finalize"]);

const DEFAULT_WORKER_LANES: WorkerLane[] = [
  {
    name: "fast",
    // PROFILE_USER_REFRESH_JOB rides here because someone is looking at that
    // profile right now: the page served the stored snapshot and its
    // stale-metadata retry is polling for what this job writes.
    jobTypes: ["refresh_user_top_scores", "refresh_country_roster", "enrich_user", "enrich_beatmap", "reconcile_user_recent_scores", PROFILE_USER_REFRESH_JOB, PROFILE_SNAPSHOT_REFRESH_JOB],
    claimLimit: 3,
    intervalMs: 750,
  },
  {
    // enrich_user also rides the fast lane, where a priority-100 interactive
    // enrichment wins a slot immediately -- but the priority-10 drip enqueues
    // never do, because that lane claims priority-desc and ingest keeps it
    // busy. Its queue reserve keeps those rows out of the shared depth count
    // (see RESERVED_LANE_TYPES); this lane is what actually drains them, so a
    // backlog can no longer sit at attempts=0 for days. Local DB work plus one
    // /users call, and the osu! token bucket still paces the requests.
    name: "enrich",
    jobTypes: ["enrich_user"],
    claimLimit: 1,
    intervalMs: 2_000,
  },
  {
    // Same story as the enrich lane, one priority tier down. Top-play
    // confirmations sit at priority 50 and lose every fast-lane slot to profile
    // refreshes (80/120), so their queue reserve keeps them out of the shared
    // depth count and this lane is what actually drains them. Deliberately slow:
    // one osu! call each, and a backlog drains on the order of hours rather than
    // spending the whole token bucket on catch-up.
    name: "top-scores",
    jobTypes: ["refresh_user_top_scores"],
    claimLimit: 1,
    intervalMs: 5_000,
  },
  {
    // Third instance of the enrich/top-scores story, and the one that actually
    // broke: rosters have a queue reserve but rode only the mixed fast lane,
    // where the priority-desc claim never reaches a scheduled refresh at
    // priority 10 while profile work (80/120) holds the three slots. Two such
    // rosters (LI, MQ) took the reserve's two slots at attempts=0 and stayed
    // there, so every other country -- including a live activation at priority
    // 85 -- was parked behind them, and no roster anywhere refreshed for two
    // days. This lane is what guarantees they drain; refresh_country_roster
    // stays in the fast lane too, so an admitted activation still runs at once
    // instead of waiting on this interval.
    name: "country-rosters",
    jobTypes: ["refresh_country_roster"],
    claimLimit: 1,
    intervalMs: 10_000,
  },
  {
    // Same structural gap as the roster lane: a queue reserve with no lane of
    // its own. Ingest re-requests a user's reconcile directly, which masks the
    // starvation most of the time, but nothing guarantees the parked ones
    // drain. Deliberately slow -- one osu! call each, and urgent reconciles
    // (priority 70) still win a fast-lane slot.
    name: "recent-reconcile",
    jobTypes: [RECENT_RECONCILE_JOB_TYPE],
    claimLimit: 1,
    intervalMs: 10_000,
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
    // GLOBAL_FARMED_BOARD_REPACK_JOB runs here: it is the serving process's
    // delegated full board pack (~1.4GB transient), the same scale of work as
    // refresh_global_maps, and claimLimit 1 keeps the two from ballooning the
    // worker concurrently.
    jobTypes: ["refresh_user_maps_farmed_scores", "refresh_country_maps", "refresh_global_maps", GLOBAL_FARMED_BOARD_REPACK_JOB, REFRESH_QUALIFIED_MAPS_JOB, RECONCILE_SETTLED_SETS_JOB],
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
    // SKILL_VECTOR_BACKFILL_JOB shares this lane because it runs the same
    // per-map compute as analyze_activity_beatmap; its deep negative priority
    // keeps interactive analyses ahead of the sweep chain.
    name: "activity-analysis",
    jobTypes: ["analyze_activity_beatmap", SKILL_VECTOR_BACKFILL_JOB, ACTIVITY_BACKFILL_JOB],
    claimLimit: 1,
    intervalMs: 1_500,
  },
  {
    // One CPU-heavy per-beatmap analysis at a time (classifier + MinaCalc,
    // ~0.1-0.3s each). The interval is what sets the 67k-chart backfill pace;
    // the work is local (cached .osu text). The one-shot wrong-file repair is
    // the exception; its own five-refetch cap and the osu! job lane pace it.
    // Tunable via CHART_ANALYSIS_LANE_INTERVAL_MS so a local backfill can run
    // flat out.
    name: "chart-analysis",
    jobTypes: [CHART_FAMILY_SWEEP_JOB, CHART_ANALYSIS_JOB, CHART_ANALYSIS_BACKFILL_JOB, VIBRO_RECOMPUTE_JOB, DAN_ELIGIBILITY_RECOMPUTE_JOB, DAN_FLOOR_PIN_RECOMPUTE_JOB, LN_SUBTYPE_RECOMPUTE_JOB, LN_SOURCE_RECOMPUTE_JOB, LN_LEOBLACK_RECOMPUTE_JOB, CHORDJACK_TAG_RECOMPUTE_JOB, JACK_TAG_RECOMPUTE_JOB, JACK_DEMAND_RECOMPUTE_JOB, MOTION_FEATURES_RECOMPUTE_JOB, BRACKET_TAG_RECOMPUTE_JOB, BRACKET_CONTENT_RECOMPUTE_JOB, DT_RATE_ANALYSIS_JOB, HT_RATE_ANALYSIS_JOB, LN_MSD_SWEEP_JOB, LN_PRIMARY_REPIN_JOB, LN7_PRIMARY_REPIN_JOB, NOTE_BPM_RECOMPUTE_JOB, OSU_FILE_REPAIR_JOB, COMPANELLA_RECOMPUTE_JOB, SUNNY_REPIN_RECOMPUTE_JOB, SUNNY_REPIN_DT_RECOMPUTE_JOB, LEOBLACK_REPIN_RECOMPUTE_JOB, LEOBLACK_REPIN_DT_RECOMPUTE_JOB, MSD_POISON_RECOVERY_JOB, INVERSE_CLUSTER_BPM_JOB, NKEY_MSD_JOB, PLAYER_SKILL_POISON_JOB, PLAYER_SKILL_FLOOR_SWEEP_JOB, PLAYER_SKILL_MSD_CAP_JOB, PLAYER_SKILL_VIBRO_SWEEP_JOB, PLAYER_SKILL_DAN_SWEEP_JOB, PLAYER_SKILL_PATTERN_SWEEP_JOB],
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
    // The top-scores backfill chain originally shared the fast lane at
    // priority -15 ("run when the lane is quiet"), but fallback-mode ingest
    // keeps that lane's queue permanently non-empty, so the chain's first
    // chunk was never claimed at all. Its own lane makes the claim
    // unconditional; the 15-minute chain runAfter still sets the pace, and
    // the osu! token bucket still governs the actual request rate.
    name: "top-scores-backfill",
    jobTypes: [TOP_SCORES_BACKFILL_JOB],
    claimLimit: 1,
    intervalMs: 5_000,
  },
  {
    // Own lane for the same reason the top-scores chain has one: a busy shared
    // lane would never claim its first link. The 2-minute chain runAfter sets
    // the pace and the osu! token bucket still governs the request rate.
    name: "activity-mods-backfill",
    jobTypes: [ACTIVITY_MODS_BACKFILL_JOB_TYPE],
    claimLimit: 1,
    intervalMs: 5_000,
  },
  {
    // The blind sweep needs a lane containing only its chain. View-driven
    // detail jobs have higher priority and can arrive continuously, so sharing
    // their lane left this one-time pass parked after its first chunk.
    name: "activity-combo-backfill",
    jobTypes: [ACTIVITY_COMBO_BACKFILL_JOB_TYPE],
    claimLimit: 1,
    intervalMs: 5_000,
  },
  {
    // Profile-driven completion stays serialized in its own lane. Both lanes
    // still pass every request through the shared osu! limiter, which owns the
    // total request budget and lets interactive traffic preempt them.
    name: "activity-detail-on-demand",
    jobTypes: [ACTIVITY_DETAIL_ON_DEMAND_JOB],
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
  {
    // Admin leaderboard imports arrive in bursts (a whole search page at a
    // time); one at a time here paces the two osu! calls each takes, and the
    // queue reserve keeps a burst from being shed as pressure.
    name: "leaderboard-import",
    jobTypes: [LEADERBOARD_IMPORT_JOB],
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
  LEADERBOARD_IMPORT_JOB,
  "compute_dan_estimate",
  "analyze_activity_beatmap",
  // CHART_ANALYSIS_JOB and PLAYER_SKILLS_JOB are deliberately absent: both are
  // local CPU work over cached .osu text. They only skip their network fetch
  // fallbacks when osu API jobs are disabled, instead of being skipped
  // wholesale here.
  BEATMAP_OSU_FILE_BACKFILL_JOB,
  PROFILE_POOL_WARM_JOB,
  PROFILE_USER_REFRESH_JOB,
  PROFILE_SNAPSHOT_REFRESH_JOB,
  TOP_SCORES_BACKFILL_JOB,
  ACTIVITY_MODS_BACKFILL_JOB_TYPE,
  ACTIVITY_COMBO_BACKFILL_JOB_TYPE,
  ACTIVITY_DETAIL_ON_DEMAND_JOB,
  OSU_FILE_REPAIR_JOB,
  // Mostly local CPU over the cached .osu corpus, but a cache miss falls
  // through to an osu! download inside the shared compute path, so it pauses
  // with the rest of the API jobs like analyze_activity_beatmap does.
  SKILL_VECTOR_BACKFILL_JOB,
]);

// The replay-video lanes exist only where ENABLE_REPLAY_VIDEO is on (the
// owner's local environment); production workers never poll for those jobs.
export function defaultWorkerLanes(): WorkerLane[] {
  if (readConfig().enableReplayVideo) return DEFAULT_WORKER_LANES;
  return DEFAULT_WORKER_LANES.filter((lane) => !REPLAY_VIDEO_LANE_NAMES.has(lane.name));
}

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
    private readonly lanes: WorkerLane[] = defaultWorkerLanes(),
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
    const lease = { workerId, attempt: job.attempts + 1 };
    const controller = new AbortController();
    const leaseGuard = maintainJobLease(this.queue, job.id, lease, controller, job.lockedUntil ? Date.parse(job.lockedUntil) : undefined);
    const clearActive = () => {
      const remaining = (this.activeJobs.get(lane) ?? []).filter((current) => current !== activeJob);
      if (remaining.length > 0) this.activeJobs.set(lane, remaining);
      else this.activeJobs.delete(lane);
    };
    let detachedCleanup = false;
    try {
      logInfo("job_start", { job_id: job.id, type: job.type, lane, worker_id: workerId, attempts: job.attempts + 1 });
      await this.handleWithWatchdog(job, lane, controller, leaseGuard.lost);
      if (!await this.queue.complete(job.id, lease)) return;
      logInfo("job_done", { job_id: job.id, type: job.type, lane, worker_id: workerId, duration_ms: Date.now() - startedAtMs });
      await this.events.append("job_status", null, { id: job.id, type: job.type, status: "done" }, `job:${job.id}:done:${job.attempts}`);
    } catch (error) {
      if (error instanceof JobLeaseLostError || controller.signal.reason instanceof JobLeaseLostError) {
        logWarn("job_lease_lost", { job_id: job.id, type: job.type, worker_id: workerId });
        return;
      }
      if (error instanceof JobWatchdogTimeoutError && error.settled) {
        // Release this lane, but keep the attempt leased while its aborted
        // handler unwinds. Retrying before it settles starts the same writes
        // and API calls twice. A truly stuck handler recovers on process restart.
        detachedCleanup = true;
        activeJob.aborting = true;
        void error.settled.then(async () => {
          const delayMs = getRetryDelayMs(job.type, job.attempts, error);
          if (await this.queue.fail(job.id, error, delayMs, lease)) {
            await this.events.append("job_status", null, { id: job.id, type: job.type, status: "failed" }, `job:${job.id}:failed:${job.attempts}`);
          }
        }).catch((cleanupError) => {
          logWarn("job_abort_cleanup_failed", { job_id: job.id, ...errorContext(cleanupError) });
        }).finally(() => { leaseGuard.stop(); clearActive(); });
        logWarn("job_watchdog_aborting", { job_id: job.id, type: job.type, lane, ...errorContext(error) });
        return;
      }
      if (await this.handleMissingUserJob(workerId, job, lane, error)) return;
      if (await this.retireEmptyMapsCountry(workerId, job, lane, error)) return;
      if (error instanceof MapsRosterNotReadyError || error instanceof DeferredJobError) {
        const retryDelayMs = error instanceof DeferredJobError ? error.delayMs : getRetryDelayMs(job.type, job.attempts, error);
        if (!await this.queue.defer(job.id, retryDelayMs, lease)) return;
        logInfo("job_deferred", { job_id: job.id, type: job.type, lane, worker_id: workerId, retry_delay_ms: retryDelayMs, reason: error.message });
        await this.events.append("job_status", null, { id: job.id, type: job.type, status: "queued", reason: error.message }, `job:${job.id}:deferred:${job.attempts}`);
        return;
      }
      const retryDelayMs = getRetryDelayMs(job.type, job.attempts, error);
      if (!await this.queue.fail(job.id, error, retryDelayMs, lease)) return;
      // A pending top-play confirmation is the queue's designed wait for a score
      // osu! has not published into the player's best-200 yet, not a fault: it
      // retries on its own backoff and gives up after a few attempts. Logged at
      // warn it was ~99% of this service's warn volume (8k in three days), so it
      // keeps the same event name and fields at info instead.
      const failureContext = { job_id: job.id, type: job.type, lane, worker_id: workerId, retry_delay_ms: retryDelayMs, ...errorContext(error) };
      if (error instanceof TopPlayConfirmationPendingError) {
        logInfo("job_failed", failureContext);
      } else {
        logWarn("job_failed", failureContext);
      }
      await this.events.append("job_status", null, { id: job.id, type: job.type, status: "failed" }, `job:${job.id}:failed:${job.attempts}`);
    } finally {
      if (!detachedCleanup) { leaseGuard.stop(); clearActive(); }
    }
  }

  private async handleWithWatchdog(job: Job, lane: string, controller = new AbortController(), leaseLost?: Promise<never>): Promise<void> {
    const timeoutMs = this.lanes.find((candidate) => candidate.name === lane)?.jobTimeoutMs ?? DEFAULT_JOB_WATCHDOG_MS;
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
        ...(leaseLost ? [leaseLost] : []),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            const error = new JobWatchdogTimeoutError(`job watchdog: ${job.type} still running after ${timeoutMs}ms, releasing the lane`);
            error.settled = handlePromise.then(() => {}, () => {});
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

  // Jobs this worker currently has in flight across every lane, including the
  // caller. Recorded alongside a job memory sample so a peak that was shared
  // with co-resident lanes is not mistaken for one job's own allocation.
  private countActiveJobs(): number {
    let count = 0;
    for (const jobs of this.activeJobs.values()) count += jobs.length;
    return count;
  }

  private async handle(job: Job, signal?: AbortSignal): Promise<void> {
    const payloadUserId = Math.floor(Number((job.payload as { userId?: unknown } | null)?.userId));
    if (Number.isSafeInteger(payloadUserId) && payloadUserId > 0 && await isUserKnownInactive(this.db, payloadUserId)) {
      logInfo("job_skipped_inactive_user", { job_id: job.id, type: job.type, user_id: payloadUserId });
      return;
    }
    if (job.type === ACTIVITY_BACKFILL_JOB) {
      throwIfAborted(signal);
      if (await runPlayerActivityBackfillJob(this.db, this.queue, job.payload, signal)) throw new DeferredJobError(1_000);
      return;
    }
    if (!readConfig().enableOsuApiJobs && OSU_API_JOB_TYPES.has(job.type)) {
      logInfo("job_skipped_osu_api_disabled", { job_id: job.id, type: job.type });
      return;
    }
    if (REPLAY_VIDEO_JOB_TYPES.has(job.type) && !readConfig().enableReplayVideo) {
      // Belt-and-braces: the lanes are gone when disabled, but an untyped claim
      // (runOnce) could still pick up a job enqueued before the flag flipped.
      // Fail the export so a polling client isn't stuck on a job nobody runs.
      const payload = job.payload as { id?: string };
      if (payload.id) await markReplayVideoFailed(this.db, payload.id, new Error("Replay video is disabled on this instance."));
      logInfo("job_skipped_replay_video_disabled", { job_id: job.id, type: job.type });
      return;
    }
    if (job.type === "refresh_user_top_scores") {
      // Skill recomputes ride the ingest-side session debounce (see
      // score-ingestor.ts), not this confirmation — one compute per session,
      // covering tracked-only sessions too.
      // Batch: this job's best-scores fetch also confirms the user's other
      // pending confirmations, so a burst of plays costs one window fetch
      // instead of one per score.
      await confirmTopPlay(this.db, this.events, this.osu, job.payload as { userId: number; scoreId: number; country: string }, { queue: this.queue, signal });
      return;
    }
    if (job.type === PROFILE_POOL_WARM_JOB) {
      await runProfilePoolWarmJob(this.db, this.queue, this.osu, job.payload as { seq?: number });
      return;
    }
    if (job.type === PROFILE_USER_REFRESH_JOB) {
      const userId = (job.payload as { userId: number }).userId;
      await runProfileUserRefreshJob(this.db, this.osu, userId);
      await reconcileGoalsForUser(this.db, this.events, userId, ["reach_pp", "reach_rank"]).catch((error) => {
        logWarn("profile_stat_goal_reconcile_failed", { user_id: userId, ...errorContext(error) });
      });
      return;
    }
    if (job.type === PROFILE_SNAPSHOT_REFRESH_JOB) {
      const userId = (job.payload as { userId: number }).userId;
      await runProfileSnapshotRefreshJob(this.db, this.osu, userId);
      await reconcileGoalsForUser(this.db, this.events, userId, ["reach_pp", "reach_rank"]).catch((error) => {
        logWarn("profile_stat_goal_reconcile_failed", { user_id: userId, ...errorContext(error) });
      });
      return;
    }
    if (job.type === ACTIVITY_MODS_BACKFILL_JOB_TYPE) {
      await runActivityModsBackfillJob(this.db, this.queue, this.osu, job.payload as { cursor?: { position: number } });
      return;
    }
    if (job.type === ACTIVITY_COMBO_BACKFILL_JOB_TYPE) {
      await runActivityComboBackfillJob(this.db, this.queue, this.osu, job.payload as { cursor?: number });
      return;
    }
    if (job.type === ACTIVITY_DETAIL_ON_DEMAND_JOB) {
      await runActivityDetailOnDemandJob(this.db, this.queue, this.osu, job.payload as { userId?: number; link?: number });
      return;
    }
    if (job.type === TOP_SCORES_BACKFILL_JOB) {
      // Per-user 404s are handled inside the chunk (markUserMissing + skip);
      // only transient API errors reach the job's fail/backoff path.
      await runTopScoresBackfillJob(this.db, this.queue, this.osu, job.payload as { cursor?: number }, signal);
      return;
    }
    if (job.type === GLOBAL_FARMED_BOARD_REPACK_JOB) {
      // The heaviest job this worker runs (~1.4GB transient, same scale as
      // refresh_global_maps); keep the same peak-memory metric so the admin
      // dashboard can see what a pack actually costs.
      const sampler = startPeakMemorySampler();
      try {
        const repackResult = await runGlobalFarmedBoardRepackJob(this.db);
        await writeJobMemoryMetric(this.db, job.type, sampler.stop(true), { concurrentJobs: this.countActiveJobs() });
        logInfo("global_farmed_board_repack_job_done", { job_id: job.id, ...repackResult });
      } catch (error) {
        await writeJobMemoryMetric(this.db, job.type, sampler.stop(false, error), { concurrentJobs: this.countActiveJobs() });
        throw error;
      }
      return;
    }
    if (job.type === "refresh_user_maps_farmed_scores") {
      // A single osu! API call plus DB writes: it hit the watchdog only when the
      // shared budget was starved (e.g. by unbatched snipe seeding). Log duration
      // so a regression back into watchdog territory is visible in journald.
      const farmedStartedAt = Date.now();
      // scoreId is the trigger score the enqueue side records (maps.ts):
      // it has to reach the job so a shared best-scores window is only reused
      // when it already contains that score.
      const result = await refreshUserMapsFarmedScores(this.db, this.osu, this.queue, job.payload as { userId: number; country: string; scoreId?: string });
      if (await isUserKnownInactive(this.db, result.userId)) return;
      logInfo("refresh_user_maps_farmed_scores_done", { user_id: result.userId, country: result.country, score_count: result.scoreCount, duration_ms: Date.now() - farmedStartedAt });
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
      await this.reconcileUserRecentScores(job.payload as RecentReconcilePayload, job.id, signal);
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
      // Popular/favourite/random still use the compatibility GLOBAL snapshot,
      // but repeated country refreshes coalesce into one quiet-period rebuild.
      // Farmed data is already current in its row-granular projection.
      await enqueueGlobalMapsRefresh(this.queue, {
        priority: 15,
        replaceDone: true,
        runAfter: globalMapsRefreshRunAfter(),
        debounce: true,
      });
      return;
    }
    if (job.type === "refresh_global_maps") {
      // Keep the historical peak metric while the row-projection rollout so a
      // live run proves the old farmed fold/serialization transient is gone.
      // Sample here rather than
      // around handleWithWatchdog: the watchdog rejects while the handler keeps
      // running detached, so a wrapper outside it would stop the sampler early
      // and under-report the peak of the run that actually mattered.
      const sampler = startPeakMemorySampler();
      try {
        await refreshGlobalMaps(this.db, signal);
        await writeJobMemoryMetric(this.db, job.type, sampler.stop(true), { concurrentJobs: this.countActiveJobs() });
      } catch (error) {
        await writeJobMemoryMetric(this.db, job.type, sampler.stop(false, error), { concurrentJobs: this.countActiveJobs() });
        throw error;
      }
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
    if (job.type === SKILL_VECTOR_BACKFILL_JOB) {
      await runSkillVectorBackfillJob(this.db, this.queue, this.osu, job.payload as { cursor?: number }, signal);
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
    if (job.type === OSU_FILE_REPAIR_JOB) {
      await runOsuFileRepairJob(this.db, this.queue, this.osu, job.payload as { cursor?: number });
      return;
    }
    if (job.type === CHART_FAMILY_SWEEP_JOB) {
      await runChartFamilySweepJob(this.db, this.queue, job.payload as { cursor?: number });
      return;
    }
    if (job.type === DAN_ELIGIBILITY_RECOMPUTE_JOB) {
      await runDanEligibilityRecomputeJob(this.db, this.queue, job.payload as { cursor?: number });
      return;
    }
    if (job.type === DAN_FLOOR_PIN_RECOMPUTE_JOB) {
      await runDanFloorPinRecomputeJob(this.db, this.queue, job.payload as { cursor?: number });
      return;
    }
    if (job.type === LN_PRIMARY_REPIN_JOB) {
      await runLnPrimaryRepinJob(this.db, this.queue, job.payload as { cursor?: number });
      return;
    }
    if (job.type === LN7_PRIMARY_REPIN_JOB) {
      await runLn7PrimaryRepinJob(this.db, this.queue, job.payload as { cursor?: number });
      return;
    }
    if (job.type === LN_SUBTYPE_RECOMPUTE_JOB) {
      await runLnSubtypeRecomputeJob(this.db, this.queue, job.payload as { cursor?: number });
      return;
    }
    if (job.type === JACK_TAG_RECOMPUTE_JOB) {
      // On the chunk that finishes the chart-side re-tag, seed the player
      // sweep that re-folds stored pattern ratings over the final tags.
      if (await runJackTagRecomputeJob(this.db, this.queue, job.payload as { cursor?: number })) {
        await ensurePlayerSkillPatternSweepSeeded(this.db, this.queue);
      }
      return;
    }
    if (job.type === JACK_DEMAND_RECOMPUTE_JOB) {
      // Player skillset verdicts consume this chart-side flag. Seed their
      // lightweight re-fold only after the final chart chunk stamps done.
      if (await runJackDemandRecomputeJob(this.db, this.queue, job.payload as { cursor?: number })) {
        await ensurePlayerSkillDanSweepSeeded(this.db, this.queue);
      }
      return;
    }
    if (job.type === MOTION_FEATURES_RECOMPUTE_JOB) {
      // The 4K speed/tech split reads these shares off every clear, so the
      // player-side re-fold only makes sense once the chart corpus is whole.
      if (await runMotionFeaturesRecomputeJob(this.db, this.queue, job.payload as { cursor?: number })) {
        await ensurePlayerSkillDanSweepSeeded(this.db, this.queue);
      }
      return;
    }
    if (job.type === COMPANELLA_RECOMPUTE_JOB) {
      await runCompanellaRecomputeJob(this.db, this.queue, job.payload as { cursor?: number });
      return;
    }
    if (job.type === CHORDJACK_TAG_RECOMPUTE_JOB) {
      await runChordjackTagRecomputeJob(this.db, this.queue, job.payload as { cursor?: number });
      return;
    }
    if (job.type === BRACKET_CONTENT_RECOMPUTE_JOB) {
      await runBracketContentRecomputeJob(this.db, this.queue, job.payload as { cursor?: number });
      return;
    }
    if (job.type === BRACKET_TAG_RECOMPUTE_JOB) {
      await runBracketTagRecomputeJob(this.db, this.queue, job.payload as { cursor?: number });
      return;
    }
    if (job.type === LN_SOURCE_RECOMPUTE_JOB) {
      await runLnSourceRecomputeJob(this.db, this.queue, job.payload as { cursor?: number });
      return;
    }
    if (job.type === LN_LEOBLACK_RECOMPUTE_JOB) {
      await runLnLeoblackRecomputeJob(this.db, this.queue, job.payload as { cursor?: number });
      return;
    }
    if (job.type === SUNNY_REPIN_RECOMPUTE_JOB) {
      await runSunnyRepinRecomputeJob(this.db, this.queue, job.payload as { cursor?: number });
      return;
    }
    if (job.type === LEOBLACK_REPIN_RECOMPUTE_JOB) {
      await runLeoblackRepinRecomputeJob(this.db, this.queue, this.osu, job.payload as { cursor?: number });
      return;
    }
    if (job.type === LEOBLACK_REPIN_DT_RECOMPUTE_JOB) {
      await runLeoblackRepinDtRecomputeJob(this.db, this.queue, job.payload as { cursor?: number });
      return;
    }
    if (job.type === SUNNY_REPIN_DT_RECOMPUTE_JOB) {
      // DT verdict repairs can lower stale LN rawDan values that stored player
      // summaries already credited. Re-seed after the final chunk; if a dan
      // pass is already in flight, its completion check schedules a clean pass.
      if (await runSunnyRepinDtRecomputeJob(this.db, this.queue, job.payload as { cursor?: number })) {
        await ensurePlayerSkillDanSweepSeeded(this.db, this.queue);
      }
      return;
    }
    if (job.type === MSD_POISON_RECOVERY_JOB) {
      await runMsdPoisonRecoveryJob(this.db, this.queue, job.payload as { cursor?: number });
      return;
    }
    if (job.type === INVERSE_CLUSTER_BPM_JOB) {
      await runInverseClusterBpmRecoveryJob(this.db, this.queue, job.payload as { cursor?: number });
      return;
    }
    if (job.type === NKEY_MSD_JOB) {
      await runNkeyMsdJob(this.db, this.queue, job.payload as { cursor?: number });
      return;
    }
    if (job.type === PLAYER_SKILL_POISON_JOB) {
      await runPlayerSkillPoisonRecoveryJob(this.db, this.queue, job.payload as { cursor?: number });
      return;
    }
    if (job.type === PLAYER_SKILL_FLOOR_SWEEP_JOB) {
      await runPlayerSkillFloorSweepJob(this.db, this.queue, job.payload as { cursor?: number });
      return;
    }
    if (job.type === PLAYER_SKILL_VIBRO_SWEEP_JOB) {
      await runPlayerSkillVibroSweepJob(this.db, this.queue, job.payload as { cursor?: number });
      return;
    }
    if (job.type === PLAYER_SKILL_MSD_CAP_JOB) {
      await runPlayerSkillMsdCapSweepJob(this.db, this.queue, job.payload as { cursor?: number });
      return;
    }
    if (job.type === PLAYER_SKILL_DAN_SWEEP_JOB) {
      await runPlayerSkillDanSweepJob(this.db, this.queue, job.payload as PlayerSkillDanSweepPayload);
      return;
    }
    if (job.type === PLAYER_SKILL_PATTERN_SWEEP_JOB) {
      // The finishing chunk forces a baseline rebuild (interval 0): the
      // percentile curves should learn the refreshed pattern axes now, not at
      // the next weekly refresh.
      if (await runPlayerSkillPatternSweepJob(this.db, this.queue, job.payload as { cursor?: number })) {
        await enqueueSkillBaselineIfDue(this.db, this.queue, 0);
      }
      return;
    }
    if (job.type === HT_RATE_ANALYSIS_JOB) {
      // On the chunk that finishes the sweep, re-seed the dan sweep: the dans
      // it wrote earlier could not credit HT clears, because these verdicts
      // did not exist yet. Its seeder compares finishedAt stamps, so this is a
      // no-op on every other boot.
      if (await runHtRateAnalysisJob(this.db, this.queue, job.payload as { cursor?: number })) {
        await ensurePlayerSkillDanSweepSeeded(this.db, this.queue);
      }
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
      // The wipe may have landed while the osu! request was in flight. The
      // start-of-job guard above cannot cover that race, so re-check at the
      // last point before this job can recreate identity or snipe metadata.
      if (await isUserKnownInactive(this.db, payload.userId)) return;
      await upsertDisplayUser(
        this.db,
        payload.userId,
        String(user.username ?? `User ${payload.userId}`),
        user,
        nowIso(),
      );
      await this.processHydratedScores({ userId: payload.userId });
      return;
    }
    if (job.type === LEADERBOARD_IMPORT_JOB) {
      const payload = job.payload as { beatmapId: number };
      // A process can die after the complete board and its durable receipt are
      // written but before queue.complete(). On reclaim, honor the same
      // seven-day guard as the HTTP route instead of spending both API calls a
      // second time. Active jobs ignore the score-event rollout fallback, so a
      // genuinely partial pre-receipt run still retries.
      const [status] = await getLeaderboardImportStatuses(this.db, [payload.beatmapId]);
      if (status?.recent) return;
      const result = await importBeatmapLeaderboard(this.db, this.queue, this.events, readConfig(), this.osu, payload.beatmapId);
      // A chart osu! turns down is a finished job, not a retry: the answer
      // will not change, and the dialog reads the reason off the job row.
      if (!result.ok) throw new LeaderboardImportRefusedError(result.reason);
      return;
    }
    if (job.type === "enrich_beatmap") {
      const payload = job.payload as { beatmapId: number };
      if (await this.hasFreshBeatmapRow(payload.beatmapId)) {
        await this.processHydratedScores({ beatmapId: payload.beatmapId });
        return;
      }
      const beatmap = await this.osu.getBeatmap(payload.beatmapId, "job:enrich_beatmap");
      await this.upsertBeatmap(beatmap, payload.beatmapId);
      // The index materializes set metadata (ranked_date, counts) only on its
      // own writes, so the fresh row goes in now; sibling diffs pick the date
      // up from the hourly reconcile.
      await upsertMapSearchIndexRow(this.db, payload.beatmapId);
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

  /* Retires a country whose maps refresh has failed the same way often enough
     that it is not going to start working: either the roster's members
     genuinely have no farmed/most-played/favourite data anywhere
     (MapsEmptyResultError), or the country has no ranked mania players at all
     and a completed roster refresh says so. The job is completed rather than
     failed, so nothing retries it, and the paused registry row keeps every
     scheduler off the country until someone visits it again. */
  private async retireEmptyMapsCountry(workerId: string, job: Job, lane: string, error: unknown): Promise<boolean> {
    if (job.type !== "refresh_country_maps") return false;
    if (Math.max(1, job.attempts + 1) < POISONED_MAPS_REFRESH_ATTEMPTS) return false;
    const country = String((job.payload as { country?: unknown }).country ?? "").trim().toUpperCase();
    if (!country) return false;
    if (error instanceof MapsRosterNotReadyError) {
      if (!await isCountryRosterConfirmedEmpty(this.db, country)) return false;
    } else if (!(error instanceof MapsEmptyResultError)) {
      return false;
    }
    if (!await retireCountry(this.db, country)) return false;
    await this.queue.complete(job.id, { workerId, attempt: job.attempts + 1 });
    logWarn("country_retired_empty", {
      job_id: job.id,
      type: job.type,
      lane,
      worker_id: workerId,
      country,
      attempts: job.attempts + 1,
      ...errorContext(error),
    });
    return true;
  }

  private async handleMissingUserJob(workerId: string, job: Job, lane: string, error: unknown): Promise<boolean> {
    if (!(error instanceof OsuApiError) || error.status !== 404 || !error.path.startsWith("/users/")) return false;
    const userId = Number((job.payload as { userId?: unknown }).userId);
    if (!Number.isInteger(userId) || userId <= 0) return false;
    const result = await markUserMissing(this.db, userId, `${job.type}: ${error.message}`);
    await this.queue.complete(job.id, { workerId, attempt: job.attempts + 1 });
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

  // A beatmap row written recently (by ingest payloads or a prior enrich)
  // already holds everything this job would buy from the osu! API: the only
  // dedupe otherwise is the done-jobs table, so once retention prunes it the
  // same map gets re-fetched every couple of days. Settled statuses are
  // near-immutable and hold for a month; in-flux ones keep a one-day window so
  // a qualified -> ranked transition still lands via the API promptly (the
  // /maps index additionally heals settled statuses from the beatmaps.status
  // column with zero API calls; see map-search.ts).
  private async hasFreshBeatmapRow(beatmapId: number): Promise<boolean> {
    // The beatmapsets join matters: ingest enqueues this job when *either*
    // half of the payload is missing, so a fresh beatmaps row can coexist with
    // a beatmapsets row that was never written. Only the pair counts as known.
    const row = (await exec(
      this.db,
      `select b.status, b.updated_at, json_extract(s.metadata_json, '$.ranked_date') as ranked_date from beatmaps b
       join beatmapsets s on s.beatmapset_id = b.beatmapset_id
       where b.beatmap_id = ? and b.metadata_json is not null`,
      [beatmapId],
    )).rows[0];
    if (!row) return false;
    const updatedAtMs = Date.parse(String(row.updated_at ?? ""));
    if (!Number.isFinite(updatedAtMs)) return false;
    const status = String(row.status ?? "").trim().toLowerCase();
    const settled = status === "ranked" || status === "approved" || status === "loved";
    // A settled set whose stored metadata is still the compact shape a score
    // payload carries (no ranked_date) has never been fetched in full, however
    // recently ingest touched the row; the full fetch is what this job is for.
    if (settled && row.ranked_date == null) return false;
    const maxAgeMs = settled ? 30 * 24 * 60 * 60_000 : 24 * 60 * 60_000;
    return Date.now() - updatedAtMs <= maxAgeMs;
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
       on conflict(beatmap_id) do update set metadata_json = excluded.metadata_json, status = excluded.status, version = excluded.version, updated_at = excluded.updated_at`,
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

  private async reconcileUserRecentScores(payload: RecentReconcilePayload, currentJobId?: number, signal?: AbortSignal): Promise<void> {
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
    throwIfAborted(signal);
    const ingested = await this.ingestor.ingestBatch(scores, source, {
      enqueueRecentReconcile: false,
      processLeaderboardFeatures: payload.processLeaderboardFeatures === true,
    });
    throwIfAborted(signal);
    const latestTrackedScoreAt = await this.getLatestActiveScoreAt(userId);
    if (latestTrackedScoreAt) {
      if (await requeueDeferredRecentReconcileJobs(this.db, userId) > 0) return;
      if (await hasPendingRecentReconcileJob(this.db, userId, {
        excludeJobId: currentJobId,
        statuses: ["queued", "failed"],
      })) return;
      const latestScoreAt = scores.reduce<string>((latest, score) => {
        const timestamp = score.ended_at ?? score.created_at;
        return timestamp && (!latest || timestamp > latest) ? timestamp : latest;
      }, latestTrackedScoreAt);
      // A play may already have arrived through the live feed, so an unchanged
      // insert count alone cannot tell us the player has stopped. Metadata
      // corrections also count as changes and reset the short polling window.
      const changed = ingested.inserted > 0 || latestScoreAt !== payload.latestScoreAt;
      const cadence = nextRecentReconcileCadence(payload.unchangedPolls, changed);
      const runAfter = new Date(Date.now() + cadence.delayMs);
      const bucket = Math.floor(runAfter.getTime() / (2 * 60_000));
      await this.queue.enqueue(
        RECENT_RECONCILE_JOB_TYPE,
        `recent:user:${userId}:next:${bucket}`,
        { ...payload, userId, latestScoreAt, unchangedPolls: cadence.unchangedPolls },
        { priority: 25, runAfter },
      );
    }
  }

  private async getLatestActiveScoreAt(userId: number): Promise<string | null> {
    const cutoff = new Date(Date.now() - 30 * 60_000).toISOString();
    const row = (await exec(
      this.db,
      `select ended_at
       from score_events
       where user_id = ?
         and ended_at >= ?
         and (source like 'osc_%' or source in ('osu_scores_fallback', 'osu_recent', 'osu_recent_fallback'))
       order by ended_at desc
       limit 1`,
      [userId, cutoff],
    )).rows[0];
    return row ? String(row.ended_at) : null;
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

// A refresh_country_maps job that keeps failing this many times with an empty
// result is poisoned, not unlucky: its roster users have no
// farmed/most-played/favourite data at all. Each of those retries re-runs the
// whole roster sweep — three osu! API calls per tracked user — and the generic
// backoff pins the job at a 60-minute retry forever, so a dead country burns
// that sweep every hour and keeps the reserved refresh_country_maps lane
// (RESERVED_LANE_TYPES in jobs/queue.ts, a single slot) busy against real
// countries.
//
// Parking it a day out fixes that without pretending the refresh succeeded: a
// completed job would drop out of hasActiveMapsRefresh and let every page view
// re-enqueue the refresh, and every successful refresh_country_maps enqueues a
// refresh_global_maps behind it. A parked job still counts as active (failed or queued with a future
// run_after), so nothing re-enqueues; activeDepth ignores future run_after, so
// the reserved lane frees up immediately; and an admin refresh still pulls it
// forward because enqueue() merges run_after with min().
const POISONED_MAPS_REFRESH_ATTEMPTS = 6;
const POISONED_MAPS_REFRESH_PARK_MS = 24 * 60 * 60_000;

// Terminal for this country regardless of when we retry. Matching on the error
// class rather than on the job type alone matters: per-user osu! failures are
// swallowed inside the refresh, but a rate limit or a 5xx is rethrown, and a
// multi-hour osu! outage must not park every country for a day.
//
// MapsRosterNotReadyError is deliberately not parked. It is raised before any
// osu! call, by a single roster query, so retrying it costs nothing — and it
// says nothing about the country's own data: a country activated while
// refresh_country_roster is failing (osu! outage, sustained 429s) raises it
// until the roster lands. Parking that would leave /maps showing the pending
// state for up to a day after osu! recovers, because the parked job still
// counts as an active refresh and nothing re-enqueues it. The bounded backoff
// retries it hourly instead and picks the country up as soon as it can.
function isPoisonedMapsRefresh(type: string, nextAttempt: number, error: unknown): boolean {
  if (type !== "refresh_country_maps") return false;
  if (nextAttempt < POISONED_MAPS_REFRESH_ATTEMPTS) return false;
  return error instanceof MapsEmptyResultError;
}

function getRetryDelayMs(type: string, attempts: number, error: unknown): number {
  if (error instanceof Error && error.message.includes("OSU_CLIENT_ID")) return 5 * 60_000;
  // A refused chart (not mania, no leaderboard) stays refused; the failed row
  // keeps the reason for the dialog and is parked rather than retried. A
  // fresh enqueue for the same chart pulls run_after back to now.
  if (error instanceof LeaderboardImportRefusedError) return 365 * 24 * 60 * 60_000;
  if (error instanceof OsuApiError && error.status === 429) {
    return Math.max(error.retryAfterMs ?? 60_000, 60_000);
  }
  const nextAttempt = Math.max(1, attempts + 1);
  // Every pending probe re-downloads the full best-200 window (two osu! calls),
  // so the wait doubles per attempt instead of holding flat at 2 minutes. Must
  // be derived from nextAttempt, not attempts: attempts is still 0 on the first
  // failure, and an attempts-based exponent fires the first retry at 1 minute.
  if (error instanceof TopPlayConfirmationPendingError) {
    return Math.min(2 * 60_000 * 2 ** Math.min(4, nextAttempt - 1), 30 * 60_000);
  }
  if (isPoisonedMapsRefresh(type, nextAttempt, error)) return POISONED_MAPS_REFRESH_PARK_MS;
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
        : type === "enrich_user" || type === PROFILE_USER_REFRESH_JOB || type === PROFILE_SNAPSHOT_REFRESH_JOB
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
