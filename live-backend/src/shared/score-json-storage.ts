import { scoreJsonCompressionEnabled } from "../config.js";
import { packDictJsonText } from "./dict-json.js";
import type { OscScore } from "./types.js";

// Writers keep text during the reader-first deployment. Maintenance compression
// is a separate explicit operation, never a multi-million-row boot migration.
export function encodeScoreJson(value: unknown): string | Buffer {
  const text = JSON.stringify(value);
  return scoreJsonCompressionEnabled() ? packDictJsonText(text) : text;
}

export function userTopScoreColumns(score: OscScore, text = JSON.stringify(score)) {
  const lower = text.toLowerCase(); // SQLite LIKE is ASCII-case-insensitive by default.
  return {
    beatmapId: score.beatmap_id ?? null,
    hasDt: lower.includes('"acronym":"dt"') || lower.includes('"acronym":"nc"') ? 1 : 0,
  };
}

export function scoreEventColumns(score: OscScore, text = JSON.stringify(score)) {
  return {
    customRate: text.toLowerCase().includes('"speed_change"') ? 1 : 0,
    modCount: Array.isArray(score.mods) ? score.mods.length : 0,
    payloadScoreId: score.id ?? null,
  };
}

export function topPlayColumns(event: { score?: OscScore }) {
  const score = event.score;
  // Keep only the embedded search fallbacks. Usually absent in lean stored
  // scores, but dropping them for legacy rows would change search/key filters.
  const beatmap = score?.beatmap;
  const beatmapset = score?.beatmapset;
  return {
    accuracy: score?.accuracy ?? null,
    modCount: Array.isArray(score?.mods) ? score.mods.length : 0,
    payloadBeatmapId: beatmap?.id ?? score?.beatmap_id ?? null,
    searchJson: beatmap || beatmapset ? JSON.stringify({ score: {
      beatmap: beatmap ? { cs: beatmap.cs, version: beatmap.version } : undefined,
      beatmapset: beatmapset ? { title: beatmapset.title, artist: beatmapset.artist } : undefined,
    } }) : null,
  };
}

/** CASE (not AND) guarantees SQLite never evaluates JSON functions on a blob.
 * Text always uses the old predicate, even if an old writer left stale columns.
 * Arguments are internal SQL fragments, never request input. */
export function scoreCellSql(cell: string, legacy: string, promoted: string): string {
  return `(case when typeof(${cell}) = 'text' then ${legacy} else ${promoted} end)`;
}

export function userTopBeatmapIdSql(alias: string): string {
  return scoreCellSql(`${alias}.score_json`, `json_extract(${alias}.score_json, '$.beatmap_id')`, `${alias}.beatmap_id`);
}

export function scoreModCountSql(alias: string): string {
  return scoreCellSql(`${alias}.score_json`, `coalesce(json_array_length(${alias}.score_json, '$.mods'), 0)`, `coalesce(${alias}.mod_count, 0)`);
}

export function topPlayModCountSql(alias: string): string {
  return scoreCellSql(`${alias}.payload_json`, `coalesce(json_array_length(${alias}.payload_json, '$.score.mods'), 0)`, `${alias}.mod_count`);
}

export function topPlayBeatmapIdSql(alias: string): string {
  return scoreCellSql(`${alias}.payload_json`, `coalesce(cast(json_extract(${alias}.payload_json, '$.score.beatmap.id') as integer), cast(json_extract(${alias}.payload_json, '$.score.beatmap_id') as integer))`, `${alias}.payload_beatmap_id`);
}

export function topPlaySearchJsonSql(alias: string): string {
  return scoreCellSql(`${alias}.payload_json`, `${alias}.payload_json`, `${alias}.score_search_json`);
}
