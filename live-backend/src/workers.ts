import type { Db } from "./db.js";
import { readConfig } from "./config.js";
import { exec, json } from "./db.js";
import { confirmTopPlay } from "./features/top-plays.js";
import type { Job, JobQueue } from "./jobs/queue.js";
import type { LiveEventLog } from "./live/event-log.js";
import type { OsuApiClient } from "./osu/client.js";
import { finishReplayVideoExport } from "./replay-video/exports.js";
import { refreshCountryRoster } from "./rosters/country-rosters.js";
import { getBoardLaneKey, getDisplayedAccuracy, getDisplayedTotalScore, getModAcronyms, isLazerScore, nowIso, scoreHasReplay } from "./shared/score.js";
import { errorContext, logInfo, logWarn } from "./logger.js";

export class WorkerRunner {
  private stopped = false;
  private paused = false;

  constructor(
    private readonly db: Db,
    private readonly queue: JobQueue,
    private readonly events: LiveEventLog,
    private readonly osu: OsuApiClient,
    private readonly workerId = `worker-${process.pid}`,
  ) {}

  start(intervalMs = 1000): () => void {
    const tick = async () => {
      if (this.stopped) return;
      await this.runOnce().catch((error) => console.warn("[worker] tick failed", error));
      if (!this.stopped) setTimeout(tick, intervalMs).unref();
    };
    setTimeout(tick, 0).unref();
    return () => {
      this.stopped = true;
    };
  }

  async runOnce(): Promise<void> {
    if (this.paused) return;
    const jobs = await this.queue.claim(this.workerId, 5);
    for (const job of jobs) {
      try {
        logInfo("job_start", { job_id: job.id, type: job.type, attempts: job.attempts + 1 });
        await this.handle(job);
        await this.queue.complete(job.id);
        logInfo("job_done", { job_id: job.id, type: job.type });
        await this.events.append("job_status", null, { id: job.id, type: job.type, status: "done" }, `job:${job.id}:done:${job.attempts}`);
      } catch (error) {
        const retryDelayMs = getRetryDelayMs(job.type, job.attempts, error);
        await this.queue.fail(job.id, error, retryDelayMs);
        logWarn("job_failed", { job_id: job.id, type: job.type, retry_delay_ms: retryDelayMs, ...errorContext(error) });
        await this.events.append("job_status", null, { id: job.id, type: job.type, status: "failed" }, `job:${job.id}:failed:${job.attempts}`);
      }
    }
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
  }

  status(): { paused: boolean; stopped: boolean; workerId: string } {
    return { paused: this.paused, stopped: this.stopped, workerId: this.workerId };
  }

  private async handle(job: Job): Promise<void> {
    if (job.type === "refresh_user_top_scores") {
      await confirmTopPlay(this.db, this.events, this.osu, job.payload as { userId: number; scoreId: number; country: string });
      return;
    }
    if (job.type === "refresh_country_roster") {
      const payload = job.payload as { country: string };
      await refreshCountryRoster(this.db, this.osu, payload.country, "job:refresh_country_roster");
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
      return;
    }
    if (job.type === "enrich_beatmap") {
      const payload = job.payload as { beatmapId: number };
      const beatmap = await this.osu.getBeatmap(payload.beatmapId, "job:enrich_beatmap");
      await this.upsertBeatmap(beatmap, payload.beatmapId);
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

  private async seedSnipeBoard(payload: { country: string; beatmapId: number; laneKey: string }): Promise<void> {
    const config = readConfig();
    const roster = (await exec(this.db, "select user_id from country_rosters where country = ? and is_tracked = 1 order by rank asc limit ?", [payload.country, config.rosterSize])).rows;
    for (const row of roster) {
      const userId = Number(row.user_id);
      const scores = await this.osu.getBeatmapUserScoresAll(payload.beatmapId, userId, "job:seed_snipe_board");
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
}

function getRetryDelayMs(type: string, attempts: number, error: unknown): number {
  if (error instanceof Error && error.message.includes("OSU_CLIENT_ID")) return 5 * 60_000;
  const nextAttempt = Math.max(1, attempts + 1);
  const base = type === "refresh_user_top_scores"
    ? 15_000
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
