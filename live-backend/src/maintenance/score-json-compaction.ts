import { exec, execBatch, type Db, type DbStatement } from "../db.js";
import { jsonCellBuffer, packDictJsonText, readJsonTextStrict, unpackDictJsonText } from "../shared/dict-json.js";
import { scoreEventColumns, topPlayColumns, userTopScoreColumns } from "../shared/score-json-storage.js";
import type { OscScore } from "../shared/types.js";
import { migrateScoreJsonStorage } from "./score-json-schema.js";

export interface ScoreJsonCompactionProgress {
  table: string;
  scanned: number;
  compressed: number;
  skipped: number;
  alreadyPacked: number;
}

/** Lossless, bounded, restartable. No deletes, metadata stripping or timestamps.
 * Each write compares the original cell so a concurrent replacement wins.
 * A bad cell aborts the pass rather than being replaced with a fallback. */
export async function compressScoreJson(db: Db, options: {
  batchSize?: number;
  betweenBatches?: () => Promise<void>;
  onProgress?: (progress: ScoreJsonCompactionProgress) => void;
} = {}): Promise<ScoreJsonCompactionProgress[]> {
  const batchSize = options.batchSize ?? 200;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 2000) throw new Error("batchSize must be an integer from 1 to 2000");
  await migrateScoreJsonStorage(db);
  const results: ScoreJsonCompactionProgress[] = [];
  for (const [table, column] of [
    ["user_top_scores", "score_json"], ["top_play_events", "payload_json"], ["score_events", "score_json"],
  ] as const) {
    const progress = { table, scanned: 0, compressed: 0, skipped: 0, alreadyPacked: 0 };
    let after: number | null = null;
    // Freeze the upper bound: a busy ingestor must not make the pass endless.
    const high = (await exec(db, `select max(rowid) as id from ${table}`)).rows[0]?.id;
    if (high == null) { results.push(progress); continue; }
    while (true) {
      const rows: Awaited<ReturnType<typeof exec>>["rows"] = (await exec(db, `select rowid as cursor, ${column} as cell from ${table}
        where ${after == null ? "" : "rowid > ? and "}rowid <= ? order by rowid limit ?`,
      after == null ? [high, batchSize] : [after, high, batchSize])).rows;
      if (!rows.length) break;
      const statements: DbStatement[] = [];
      for (const row of rows) {
        after = Number(row.cursor);
        progress.scanned++;
        const text = readJsonTextStrict(row.cell);
        if (jsonCellBuffer(row.cell)?.[0] === 0) { progress.alreadyPacked++; continue; }
        const parsed = JSON.parse(text);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`Invalid score object in ${table} row ${after}`);
        const packed = packDictJsonText(text);
        if (unpackDictJsonText(packed) !== text) throw new Error(`Score round-trip mismatch in ${table} row ${after}`);
        let columns: Record<string, string | number | null>;
        if (table === "user_top_scores") {
          const fields = userTopScoreColumns(parsed as OscScore, text);
          columns = { beatmap_id: fields.beatmapId, has_dt: fields.hasDt };
        } else if (table === "top_play_events") {
          const fields = topPlayColumns(parsed);
          columns = { accuracy: fields.accuracy, mod_count: fields.modCount, payload_beatmap_id: fields.payloadBeatmapId, score_search_json: fields.searchJson };
        } else {
          const fields = scoreEventColumns(parsed as OscScore, text);
          columns = { custom_rate: fields.customRate, mod_count: fields.modCount, payload_score_id: fields.payloadScoreId };
        }
        statements.push({
          sql: `update ${table} set ${column} = ?, ${Object.keys(columns).map((key) => `${key} = ?`).join(", ")}
            where rowid = ? and ${column} = ?`,
          args: [packed, ...Object.values(columns), row.cursor, row.cell],
        });
      }
      if (statements.length) {
        const writes = await execBatch(db, statements);
        const changed = writes.reduce((sum, result) => sum + Number(result.rowsAffected), 0);
        progress.compressed += changed;
        progress.skipped += statements.length - changed;
      }
      options.onProgress?.({ ...progress });
      await (options.betweenBatches?.() ?? new Promise<void>((resolve) => setImmediate(resolve)));
    }
    results.push(progress);
  }
  return results;
}
