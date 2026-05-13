import type { Config } from "../config.js";
import type { Db } from "../db.js";
import { exec, json } from "../db.js";
import { getActiveCountryCodes, markCountryScoreSeen } from "../countries.js";
import { updateSnipeProjection } from "../features/snipes.js";
import { maybeEnqueueTopPlayRefresh } from "../features/top-plays.js";
import { getTrackerScoreById } from "../features/tracker.js";
import type { JobQueue } from "../jobs/queue.js";
import type { LiveEventLog } from "../live/event-log.js";
import { getBoardLaneKey, getDisplayedAccuracy, getDisplayedTotalScore, getModAcronyms, isLazerScore, nowIso, scoreHasReplay } from "../shared/score.js";
import type { OscScore } from "../shared/types.js";
import { logInfo } from "../logger.js";

export class ScoreIngestor {
  constructor(
    private readonly db: Db,
    private readonly queue: JobQueue,
    private readonly events: LiveEventLog,
    private readonly config: Pick<Config, "topPlayMarginPp" | "trackedCountries" | "countryWarmTtlMs" | "osuClientId" | "osuClientSecret">,
  ) {}

  async ingestBatch(scores: OscScore[], source = "osc_socket"): Promise<{ inserted: number; skipped: number }> {
    let inserted = 0;
    let skipped = 0;
    for (const score of scores) {
      const didInsert = await this.ingestScore(score, source);
      if (didInsert) inserted++;
      else skipped++;
    }
    return { inserted, skipped };
  }

  async ingestScore(score: OscScore, source = "osc_socket"): Promise<boolean> {
    if (score.ruleset_id !== 3) return false;
    const scoreId = Number(score.id);
    const beatmapId = Number(score.beatmap_id ?? score.beatmap?.id);
    if (!Number.isFinite(scoreId) || scoreId <= 0 || !Number.isFinite(beatmapId) || beatmapId <= 0) return false;
    const receivedAt = nowIso();
    const country = await this.getTrackedCountry(score);
    if (!country) return false;
    logInfo("score_ingest", { score_id: scoreId, user_id: score.user_id, country, beatmap_id: beatmapId, source });
    await this.persistMetadata(score);
    const totalScore = getDisplayedTotalScore(score);
    const result = await exec(
      this.db,
      `insert or ignore into score_events
       (score_id, legacy_score_id, user_id, country, beatmap_id, ruleset_id, score_json, pp, total_score, accuracy, rank, passed, processed, is_lazer, has_replay, ended_at, received_at, source)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        scoreId,
        score.legacy_score_id ?? null,
        score.user_id,
        country,
        beatmapId,
        3,
        json(score),
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
    if (result.rowsAffected === 0) return false;
    await markCountryScoreSeen(this.db, country);
    await this.updateOscCursor(score, receivedAt);
    const canUseOsuApi = this.canUseOsuApi();
    if (canUseOsuApi && country && !score.user) {
      await this.queue.enqueue("enrich_user", `user:${score.user_id}`, { userId: score.user_id }, { priority: 100 });
    }
    if (canUseOsuApi && country && (!score.beatmap || !score.beatmapset)) {
      await this.queue.enqueue("enrich_beatmap", `beatmap:${beatmapId}`, { beatmapId }, { priority: 90 });
    }
    const liveScore = await getTrackerScoreById(this.db, scoreId);
    if (liveScore) {
      await this.events.append("tracker_score", liveScore.country, liveScore.score, `tracker_score:${liveScore.country}:${score.id}`);
    }
    if (!country || !score.beatmap || !score.beatmapset || !score.user) return true;
    if (canUseOsuApi) {
      await maybeEnqueueTopPlayRefresh(this.db, this.queue, country, score, this.config.topPlayMarginPp);
      await this.enqueueSnipeSeedIfNeeded(country, score);
    }
    await updateSnipeProjection(this.db, this.events, country, score);
    return true;
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

  private async enqueueSnipeSeedIfNeeded(country: string, score: OscScore): Promise<void> {
    if (!score.beatmap) return;
    const laneKey = getBoardLaneKey(getModAcronyms(score.mods), isLazerScore(score));
    const row = (await exec(
      this.db,
      "select 1 from country_beatmap_scores where country = ? and beatmap_id = ? and lane_key = ? limit 1",
      [country, score.beatmap.id, laneKey],
    )).rows[0];
    if (row) return;
    await this.queue.enqueue(
      "seed_snipe_board",
      `snipe-seed:${country}:${score.beatmap.id}:${laneKey}`,
      { country, beatmapId: score.beatmap.id, laneKey },
      { priority: 20 },
    );
  }

  private async getTrackedCountry(score: OscScore): Promise<string | null> {
    const trackedCountrySet = new Set(await getActiveCountryCodes(this.db, this.config));
    const knownRows = (await exec(this.db, "select country from country_rosters where user_id = ? and is_tracked = 1", [score.user_id])).rows;
    const known = knownRows.map((row) => String(row.country).toUpperCase()).find((country) => trackedCountrySet.has(country));
    if (known) return known;
    const userCountry = score.user?.country_code?.toUpperCase();
    if (userCountry && trackedCountrySet.has(userCountry)) return userCountry;
    return null;
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
