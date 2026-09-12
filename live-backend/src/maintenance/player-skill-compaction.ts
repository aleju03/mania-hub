import { exec, type Db } from "../db.js";
import { packJson, unpackJson } from "../shared/compressed-json.js";

// Rewrites legacy plain-text plays_json cells as gzipped blobs (the compute
// and every sweep write the compressed form; this migrates the backlog, the
// single largest column in the database). One row per statement: a cell can
// run to several MB, and the point is to free space, not to hold a batch of
// them in the heap at once. Pages select users before versions, so advancing
// the user cursor cannot strand another version of the same player's row.
export async function compressPlayerSkillPlays(
  db: Db,
  batchSize: number,
  releaseMemory: () => Promise<void> = () => new Promise((resolve) => setImmediate(resolve)),
): Promise<{ scanned: number; compressed: number; failed: number }> {
  const result = { scanned: 0, compressed: 0, failed: 0 };
  const limit = Math.max(1, Math.floor(batchSize));
  let afterUserId = 0;

  while (true) {
    const rows = (await exec(
      db,
      `select user_id, analysis_version
       from player_skill_ratings
       where user_id in (
         select distinct user_id from player_skill_ratings
         where user_id > ? and typeof(plays_json) = 'text'
         order by user_id
         limit ?
       ) and typeof(plays_json) = 'text'
       order by user_id, analysis_version`,
      [afterUserId, limit],
    )).rows;

    if (rows.length === 0) break;
    result.scanned += rows.length;

    for (const row of rows) {
      const userId = Number(row.user_id);
      const analysisVersion = Number(row.analysis_version);
      afterUserId = Math.max(afterUserId, userId);
      const cell = (await exec(
        db,
        "select plays_json from player_skill_ratings where user_id = ? and analysis_version = ? and typeof(plays_json) = 'text'",
        [userId, analysisVersion],
      )).rows[0];
      if (!cell) continue;
      const stored = unpackJson<Record<string, unknown> | null>(cell.plays_json, null);
      if (!stored || typeof stored !== "object") {
        result.failed++;
        continue;
      }
      // A live compute/repair may replace this cell while we pack it. Only
      // convert the exact value read, preserving any newer evidence.
      const updated = await exec(
        db,
        "update player_skill_ratings set plays_json = ? where user_id = ? and analysis_version = ? and plays_json = ?",
        [packJson(stored), userId, analysisVersion, cell.plays_json],
      );
      result.compressed += Number(updated.rowsAffected);
      await releaseMemory();
    }

    await releaseMemory();
    if (rows.length < limit) break;
  }

  return result;
}
