import type { Db } from "../db.js";
import { jsonCellBuffer, scoreDictionaryBytes, SCORE_DICTIONARY_SHA256, SCORE_DICTIONARY_VERSION } from "../shared/dict-json.js";

export async function migrateScoreJsonStorage(db: Pick<Db, "execute">): Promise<void> {
  await db.execute(`create table if not exists codec_dictionaries (
    version integer primary key, bytes blob not null, sha256 text not null
  )`);
  const bytes = scoreDictionaryBytes();
  await db.execute({ sql: "insert or ignore into codec_dictionaries(version, bytes, sha256) values (?, ?, ?)", args: [SCORE_DICTIONARY_VERSION, bytes, SCORE_DICTIONARY_SHA256] });
  const stored = (await db.execute({ sql: "select bytes, sha256 from codec_dictionaries where version = ?", args: [SCORE_DICTIONARY_VERSION] })).rows[0];
  if (!jsonCellBuffer(stored?.bytes)?.equals(bytes) || stored?.sha256 !== SCORE_DICTIONARY_SHA256) {
    throw new Error("Stored score dictionary differs from frozen codec dictionary");
  }
  for (const [table, additions] of Object.entries({
    user_top_scores: { beatmap_id: "integer", has_dt: "integer" },
    top_play_events: { accuracy: "real", mod_count: "integer", payload_beatmap_id: "integer", score_search_json: "text" },
    score_events: { custom_rate: "integer", mod_count: "integer", payload_score_id: "integer" },
  })) {
    const columns = new Set((await db.execute(`pragma table_info(${table})`)).rows.map((row) => String(row.name)));
    for (const [column, type] of Object.entries(additions)) {
      if (!columns.has(column)) await db.execute(`alter table ${table} add column ${column} ${type}`);
    }
  }
}
