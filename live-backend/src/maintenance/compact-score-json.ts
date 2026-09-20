import { readConfig, scoreJsonCompressionEnabled } from "../config.js";
import { createRuntimeDb } from "../db.js";
import { logInfo } from "../logger.js";
import { compressScoreJson } from "./score-json-compaction.js";

// Online conversion only. VACUUM/swap remains the separate offline procedure.
if (process.argv.length > 2) throw new Error("This command takes no arguments; see docs/backend.md for offline vacuuming.");
if (!scoreJsonCompressionEnabled()) throw new Error("Enable SCORE_JSON_COMPRESSION_ENABLED only after upgrading every reader/writer process.");
const db = await createRuntimeDb({ ...readConfig(), sqliteCacheMb: 16, sqliteMmapMb: 0 });
let lastLog = 0;
try {
  const results = await compressScoreJson(db, { onProgress: (progress) => {
    if (Date.now() - lastLog < 10_000) return;
    lastLog = Date.now();
    logInfo("score_json_compaction_progress", { ...progress });
  } });
  logInfo("score_json_compaction_complete", { results });
} finally {
  db.close();
}
