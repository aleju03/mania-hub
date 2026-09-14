import { exec, type Db } from "../db.js";

const TARGETS = [
  ["map_search_index", ["msd_json", "msd_ln_json"]],
  ["beatmap_chart_analysis", ["msd_json", "msd_dt_json", "msd_ht_json", "msd_ln_json"]],
  ["dan_estimates", ["msd_json"]],
  ["dan_mod_estimates", ["msd_json"]],
] as const;

export interface LnCompactionProgress {
  table: string;
  cursor: number;
  scanned: number;
  strippedCells: number;
  strippedTags: number;
}

// Page row IDs before inspecting JSON. Each UPDATE transforms the current cell
// inside SQLite, so a concurrent refresh can never be overwritten by a stale
// JS copy. Ratings, evidence outside lnSkill.structure, and timestamps survive.
// No version bump: dropping a preview must not invalidate a current rating.
export async function compactLnArtifacts(
  db: Db,
  options: {
    batchSize?: number;
    onProgress?: (progress: LnCompactionProgress) => void;
    betweenBatches?: () => Promise<void>;
  } = {},
): Promise<LnCompactionProgress[]> {
  const limit = Math.max(1, Math.min(500, Math.floor(options.batchSize ?? 50)));
  const results: LnCompactionProgress[] = [];
  for (const [table, columns] of TARGETS) {
    const progress: LnCompactionProgress = { table, cursor: 0, scanned: 0, strippedCells: 0, strippedTags: 0 };
    while (true) {
      const rows = (await exec(db, `select rowid as id from ${table} where rowid > ? order by rowid limit ?`,
        [progress.cursor, limit])).rows;
      if (!rows.length) break;
      const previous = progress.cursor;
      progress.cursor = Number(rows[rows.length - 1].id);
      progress.scanned += rows.length;
      for (const column of columns) {
        const result = await exec(db, `update ${table}
          set ${column} = json_remove(${column}, '$.lnSkill.structure')
          where rowid > ? and rowid <= ?
            and case when json_valid(${column}) then json_type(${column}, '$.lnSkill.structure') is not null else 0 end`,
        [previous, progress.cursor]);
        progress.strippedCells += Number(result.rowsAffected);
      }
      if (table === "map_search_index") {
        // Existing tags are space-delimited; pad also accepts older unpadded
        // cells while preserving all unrelated pattern IDs.
        const cleaned = "trim(replace(replace(' ' || trim(pattern_tags) || ' ', ' lnshield ', ' '), ' lnreverseshield ', ' '))";
        const result = await exec(db, `update map_search_index
          set pattern_tags = case when ${cleaned} = '' then '' else ' ' || ${cleaned} || ' ' end
          where rowid > ? and rowid <= ?
            and (instr(' ' || trim(pattern_tags) || ' ', ' lnshield ') > 0
              or instr(' ' || trim(pattern_tags) || ' ', ' lnreverseshield ') > 0)`,
        [previous, progress.cursor]);
        progress.strippedTags += Number(result.rowsAffected);
      }
      options.onProgress?.({ ...progress });
      await (options.betweenBatches?.() ?? new Promise<void>((resolve) => setTimeout(resolve, 25)));
    }
    results.push({ ...progress });
  }
  return results;
}
