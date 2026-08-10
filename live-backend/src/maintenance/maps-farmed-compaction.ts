import type { Db } from "../db.js";
import { exec, json } from "../db.js";
import { unpackJson } from "../shared/compressed-json.js";
import { getModAcronyms, getScoreJudgementCount, getScoreSpeedBucket, getScoreTimestamp, getStoredScoreAccuracy, normalizeStoredMods, nowIso } from "../shared/score.js";
import { persistScoresDisplayMetadata } from "../shared/score-storage.js";
import type { OscScore } from "../shared/types.js";

export interface MapsFarmedCompactionResult {
  scanned: number;
  compacted: number;
  failed: number;
}

/**
 * Blanks the bulky per-score JSON on country_maps_farmed_scores rows while
 * hoisting everything the row still needs into dedicated columns first:
 * score_id, mods, score URL, played_at, and the peer-accuracy pair
 * (accuracy + note_count). Rows written before the accuracy columns existed
 * still hold full score_json, so this pass backfills those columns from it;
 * compaction enriches the row instead of destroying data. Rows that were
 * already blanked are never selected, so their columns are left untouched.
 *
 * Shared by the compact:storage and compact:maps-farmed maintenance scripts.
 */
export async function compactMapsFarmedOverlay(db: Db, batchSize: number): Promise<MapsFarmedCompactionResult> {
  const result: MapsFarmedCompactionResult = { scanned: 0, compacted: 0, failed: 0 };

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
      const mods = getModAcronyms(score.mods);
      const normalizedMods = normalizeStoredMods(mods);
      await exec(
        db,
        `update country_maps_farmed_scores
         set score_id = ?,
             score_json = '{}',
             mods_json = ?,
             score_url = ?,
             played_at = ?,
             accuracy = ?,
             note_count = ?,
             speed_bucket = ?,
             mods_key = ?
         where country = ? and user_id = ? and beatmap_id = ?`,
        [
          getMapsFarmedDisplayScoreId(score),
          json(mods),
          getScoreUrl(score),
          getScoreTimestamp(score) || null,
          getStoredScoreAccuracy(score),
          getScoreJudgementCount(score),
          getScoreSpeedBucket(normalizedMods),
          normalizedMods.join(","),
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

async function releaseMemory(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  (globalThis as { gc?: () => void }).gc?.();
}

function parseScore(value: unknown): OscScore | null {
  const parsed = unpackJson<Partial<OscScore> | null>(value, null);
  if (!parsed || !Number.isFinite(parsed.id) || !Number.isFinite(parsed.user_id)) return null;
  return parsed as OscScore;
}

function getMapsFarmedDisplayScoreId(score: OscScore): number {
  return score.legacy_score_id != null && score.legacy_score_id > 0 ? score.legacy_score_id : score.id;
}

function getScoreUrl(score: OscScore): string | null {
  if (score.id <= 0) return null;
  if (score.type === "solo_score") return `https://osu.ppy.sh/scores/${score.id}`;
  return `https://osu.ppy.sh/scores/${score.beatmap?.mode ?? "mania"}/${score.id}`;
}
