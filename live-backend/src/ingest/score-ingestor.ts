import type { Config } from "../config.js";
import type { Db } from "../db.js";
import { exec, json } from "../db.js";
import { canSeedSnipesForCountry, getActiveCountryCodes, markCountryScoreSeen } from "../countries.js";
import { maybeEnqueueMapsFarmedRefresh } from "../features/maps.js";
import { updateSnipeProjection } from "../features/snipes.js";
import { maybeEnqueueTopPlayRefresh } from "../features/top-plays.js";
import { getTrackerScoreByIdentity } from "../features/tracker.js";
import type { JobQueue } from "../jobs/queue.js";
import { hasPendingRecentReconcileJob, RECENT_RECONCILE_JOB_TYPE } from "../jobs/recent-reconcile.js";
import type { LiveEventLog } from "../live/event-log.js";
import { getBoardLaneKey, getDisplayedAccuracy, getDisplayedTotalScore, getModAcronyms, getScoreIdentity, isLazerScore, nowIso, scoreHasPublicLeaderboard, scoreHasReplay } from "../shared/score.js";
import type { OscScore } from "../shared/types.js";
import { logInfo } from "../logger.js";
import { isUserKnownInactive } from "../users.js";

export interface ScoreIngestOptions {
  enqueueRecentReconcile?: boolean;
  processLeaderboardFeatures?: boolean;
  processTopPlayFeatures?: boolean;
  processMapsFarmedFeatures?: boolean;
  processSnipeFeatures?: boolean;
  countryAllowlist?: string[];
}

export class ScoreIngestor {
  constructor(
    private readonly db: Db,
    private readonly queue: JobQueue,
    private readonly events: LiveEventLog,
    private readonly config: Pick<Config, "topPlayMarginPp" | "trackedCountries" | "countryWarmTtlMs" | "osuClientId" | "osuClientSecret"> & Partial<Pick<Config, "prewarmCountries" | "mapsWarmCountries">>,
  ) {}

  async ingestBatch(scores: OscScore[], source = "osc_socket", options: ScoreIngestOptions = {}): Promise<{ inserted: number; skipped: number }> {
    let inserted = 0;
    let skipped = 0;
    for (const score of scores) {
      const didInsert = await this.ingestScore(score, source, options);
      if (didInsert) inserted++;
      else skipped++;
    }
    return { inserted, skipped };
  }

  async processHydratedSnipeFeatures(country: string, score: OscScore): Promise<void> {
    if (!score.beatmap || !score.beatmapset || !score.user) return;
    if (!await canSeedSnipesForCountry(this.db, this.config, country)) return;
    if (this.canUseOsuApi() && await this.enqueueSnipeSeedIfNeeded(country, score)) return;
    await updateSnipeProjection(this.db, this.events, country, score);
  }

  async ingestScore(score: OscScore, source = "osc_socket", options: ScoreIngestOptions = {}): Promise<boolean> {
    const enqueueRecentReconcile = options.enqueueRecentReconcile ?? source !== "osu_recent";
    const processLeaderboardFeatures = options.processLeaderboardFeatures ?? source !== "osu_recent";
    const processTopPlayFeatures = options.processTopPlayFeatures ?? processLeaderboardFeatures;
    const processMapsFarmedFeatures = options.processMapsFarmedFeatures ?? processLeaderboardFeatures;
    const processSnipeFeatures = options.processSnipeFeatures ?? processLeaderboardFeatures;
    if (score.ruleset_id != null && score.ruleset_id !== 3) return false;
    const scoreId = Number(score.id);
    const beatmapId = Number(score.beatmap_id ?? score.beatmap?.id);
    if (!Number.isFinite(scoreId) || scoreId < 0 || !Number.isFinite(beatmapId) || beatmapId <= 0) return false;
    const receivedAt = nowIso();
    const countries = await this.getTrackedCountries(score, options.countryAllowlist);
    if (countries.length === 0) return false;
    logInfo("score_ingest", { score_id: scoreId, user_id: score.user_id, countries, beatmap_id: beatmapId, source });
    await this.persistMetadata(score);
    const totalScore = getDisplayedTotalScore(score);
    const scoreIdentity = getScoreIdentity(score);
    let inserted = 0;
    for (const country of countries) {
      const result = await exec(
        this.db,
        `insert into score_events
         (score_id, score_identity, legacy_score_id, user_id, country, beatmap_id, ruleset_id, score_json, pp, total_score, accuracy, rank, passed, processed, is_lazer, has_replay, ended_at, received_at, source)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         on conflict(country, score_identity) do update set
           legacy_score_id = excluded.legacy_score_id,
           score_json = excluded.score_json,
           pp = excluded.pp,
           total_score = excluded.total_score,
           accuracy = excluded.accuracy,
           rank = excluded.rank,
           passed = excluded.passed,
           processed = excluded.processed,
           is_lazer = excluded.is_lazer,
           has_replay = excluded.has_replay,
           ended_at = excluded.ended_at,
           received_at = excluded.received_at,
           source = excluded.source
         where not (score_events.score_json like '%"speed_change"%'
                    and excluded.score_json not like '%"speed_change"%')
           and (
             score_events.score_json <> excluded.score_json
             or score_events.pp is not excluded.pp
             or score_events.total_score is not excluded.total_score
             or score_events.accuracy is not excluded.accuracy
             or score_events.rank is not excluded.rank
             or score_events.passed is not excluded.passed
             or score_events.processed is not excluded.processed
             or score_events.is_lazer is not excluded.is_lazer
             or score_events.has_replay is not excluded.has_replay
             or score_events.ended_at is not excluded.ended_at
           )`,
        [
          scoreId,
          scoreIdentity,
          score.legacy_score_id ?? null,
          score.user_id,
          country,
          beatmapId,
          3,
          json(toStoredScoreEvent(score)),
          score.pp,
          totalScore,
          getDisplayedAccuracy(score),
          score.rank,
          score.passed ? 1 : 0,
          score.processed ? 1 : 0,
          isLazerScore(score) ? 1 : 0,
          scoreHasReplay(score) ? 1 : 0,
          score.ended_at ?? score.created_at ?? receivedAt,
          receivedAt,
          source,
        ],
      );
      if (scoreId > 0) {
        await this.deleteMatchingIdZeroRecentScore(country, score, beatmapId, totalScore, receivedAt);
      }
      if (result.rowsAffected === 0) continue;
      inserted++;
      await markCountryScoreSeen(this.db, country);
      const liveScore = await getTrackerScoreByIdentity(this.db, country, scoreIdentity);
      if (liveScore) {
        await this.events.append("tracker_score", liveScore.country, liveScore.score, `tracker_score:${liveScore.country}:${scoreIdentity}`);
      }
    }
    if (inserted === 0) return false;
    if (source.startsWith("osc_")) await this.updateOscCursor(score, receivedAt);
    const canUseOsuApi = this.canUseOsuApi();
    const userKnownInactive = await isUserKnownInactive(this.db, score.user_id);
    if (canUseOsuApi && !userKnownInactive && !score.user) {
      await this.queue.enqueue("enrich_user", `user:${score.user_id}`, { userId: score.user_id }, { priority: 100 });
    }
    if (canUseOsuApi && (!score.beatmap || !score.beatmapset)) {
      await this.queue.enqueue("enrich_beatmap", `beatmap:${beatmapId}`, { beatmapId }, { priority: 90 });
    }
    if (canUseOsuApi && !userKnownInactive && enqueueRecentReconcile) {
      await this.enqueueRecentReconcileIfDue(score);
    }
    if (canUseOsuApi && !userKnownInactive && (processTopPlayFeatures || processMapsFarmedFeatures)) {
      for (const country of countries) {
        if (processTopPlayFeatures) {
          await maybeEnqueueTopPlayRefresh(this.db, this.queue, country, score, this.config.topPlayMarginPp);
        }
        if (processMapsFarmedFeatures) {
          await maybeEnqueueMapsFarmedRefresh(this.db, this.queue, country, score, this.config.topPlayMarginPp);
        }
      }
    }
    if (!score.beatmap || !score.beatmapset || !score.user) return true;
    if (processSnipeFeatures) {
      for (const country of countries) {
        if (!await canSeedSnipesForCountry(this.db, this.config, country)) continue;
        if (canUseOsuApi && await this.enqueueSnipeSeedIfNeeded(country, score)) continue;
        await updateSnipeProjection(this.db, this.events, country, score);
      }
    }
    return true;
  }

  private async deleteMatchingIdZeroRecentScore(
    country: string,
    score: OscScore,
    beatmapId: number,
    totalScore: number | null,
    receivedAt: string,
  ): Promise<void> {
    if (totalScore == null) return;
    await exec(
      this.db,
      `delete from score_events
       where country = ?
         and score_id = 0
         and user_id = ?
         and beatmap_id = ?
         and ended_at = ?
         and total_score = ?`,
      [country, score.user_id, beatmapId, score.ended_at ?? score.created_at ?? receivedAt, totalScore],
    );
  }

  private async updateOscCursor(score: OscScore, receivedAt: string): Promise<void> {
    const next = new Date(score.ended_at ?? score.created_at ?? receivedAt).getTime();
    if (!Number.isFinite(next)) return;
    const row = (await exec(this.db, "select value_json from live_meta where key = 'osc_last_seen_ms'")).rows[0];
    const current = Number.parseInt(typeof row?.value_json === "string" ? row.value_json : "0", 10);
    if (Number.isFinite(current) && current >= next) return;
    await exec(this.db, "insert or replace into live_meta (key, value_json, updated_at) values ('osc_last_seen_ms', ?, ?)", [
      json(next),
      receivedAt,
    ]);
  }

  private canUseOsuApi(): boolean {
    return !!this.config.osuClientId && !!this.config.osuClientSecret;
  }

  private async enqueueSnipeSeedIfNeeded(country: string, score: OscScore): Promise<boolean> {
    if (!score.beatmap) return false;
    if (!scoreHasPublicLeaderboard(score)) return false;
    const laneKey = getBoardLaneKey(getModAcronyms(score.mods), isLazerScore(score));
    const row = (await exec(
      this.db,
      "select 1 from country_beatmap_scores where country = ? and beatmap_id = ? and lane_key = ? limit 1",
      [country, score.beatmap.id, laneKey],
    )).rows[0];
    if (row) return false;
    await this.queue.enqueue(
      "seed_snipe_board",
      `snipe-seed:${country}:${score.beatmap.id}:${laneKey}`,
      { country, beatmapId: score.beatmap.id, laneKey },
      { priority: 20, replaceDone: true },
    );
    return true;
  }

  private async enqueueRecentReconcileIfDue(score: OscScore): Promise<void> {
    const scoreTime = new Date(score.ended_at ?? score.created_at ?? 0).getTime();
    if (!Number.isFinite(scoreTime) || Date.now() - scoreTime > 30 * 60_000) return;
    const userId = score.user_id;
    const dedupeKey = `recent:user:${userId}`;
    if (await hasPendingRecentReconcileJob(this.db, userId)) return;
    const row = (await exec(
      this.db,
      "select status, updated_at from jobs where dedupe_key = ?",
      [dedupeKey],
    )).rows[0];
    if (row && String(row.status) !== "done") return;
    const updatedAt = row?.updated_at == null ? 0 : new Date(String(row.updated_at)).getTime();
    if (Number.isFinite(updatedAt) && Date.now() - updatedAt < 2 * 60_000) return;
    await this.queue.enqueue(RECENT_RECONCILE_JOB_TYPE, dedupeKey, { userId }, { priority: 70, replaceDone: true });
  }

  private async getTrackedCountries(score: OscScore, countryAllowlist?: string[]): Promise<string[]> {
    const trackedCountrySet = new Set(await getActiveCountryCodes(this.db, this.config));
    const allowedCountries = countryAllowlist == null
      ? null
      : new Set(countryAllowlist.map((country) => country.trim().toUpperCase()).filter((country) => /^[A-Z]{2}$/.test(country)));
    const knownRows = (await exec(this.db, "select country from country_rosters where user_id = ? and is_tracked = 1", [score.user_id])).rows;
    const countries = new Set(
      knownRows
        .map((row) => String(row.country).toUpperCase())
        .filter((country) => trackedCountrySet.has(country) && (allowedCountries == null || allowedCountries.has(country))),
    );
    const userCountry = score.user?.country_code?.toUpperCase();
    if (userCountry && trackedCountrySet.has(userCountry) && (allowedCountries == null || allowedCountries.has(userCountry))) countries.add(userCountry);
    return [...countries];
  }

  private async persistMetadata(score: OscScore): Promise<void> {
    const now = nowIso();
    if (score.user) {
      await exec(
        this.db,
        `insert into users (user_id, username, avatar_url, country_code, profile_json, updated_at)
         values (?, ?, ?, ?, ?, ?)
         on conflict(user_id) do update set username = excluded.username, avatar_url = excluded.avatar_url, country_code = excluded.country_code, updated_at = excluded.updated_at`,
        [score.user.id, score.user.username, score.user.avatar_url, score.user.country_code, json(score.user), now],
      );
      const activeCountries = await getActiveCountryCodes(this.db, this.config);
      if (score.user.country_code && activeCountries.includes(score.user.country_code.toUpperCase())) {
        await exec(
          this.db,
          `insert or ignore into country_rosters (country, user_id, rank, source, is_tracked, refreshed_at)
           values (?, ?, null, 'score', 1, ?)`,
          [score.user.country_code, score.user.id, now],
        );
      }
    }
    if (score.beatmapset) {
      await exec(
        this.db,
        `insert into beatmapsets (beatmapset_id, title, artist, creator, status, covers_json, metadata_json, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?)
         on conflict(beatmapset_id) do update set title = excluded.title, artist = excluded.artist, covers_json = excluded.covers_json, updated_at = excluded.updated_at`,
        [score.beatmapset.id, score.beatmapset.title, score.beatmapset.artist, score.beatmapset.creator ?? null, score.beatmapset.status ?? null, json(score.beatmapset.covers), json(score.beatmapset), now],
      );
    }
    if (score.beatmap) {
      await exec(
        this.db,
        `insert into beatmaps (beatmap_id, beatmapset_id, mode, status, cs, difficulty_rating, bpm, max_combo, version, url, metadata_json, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         on conflict(beatmap_id) do update set version = excluded.version, metadata_json = excluded.metadata_json, updated_at = excluded.updated_at`,
        [score.beatmap.id, score.beatmap.beatmapset_id, score.beatmap.mode, score.beatmap.status ?? null, score.beatmap.cs, score.beatmap.difficulty_rating, score.beatmap.bpm, score.beatmap.max_combo ?? null, score.beatmap.version, score.beatmap.url, json(score.beatmap), now],
      );
    }
  }
}

export function toStoredScoreEvent(score: OscScore): Omit<OscScore, "user" | "beatmap" | "beatmapset"> {
  const { user: _user, beatmap: _beatmap, beatmapset: _beatmapset, ...stored } = score;
  return stored;
}
