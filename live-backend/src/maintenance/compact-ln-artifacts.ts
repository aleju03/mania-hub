import { readConfig } from "../config.js";
import { createRuntimeDb } from "../db.js";
import { logInfo } from "../logger.js";
import { compactLnArtifacts } from "./ln-artifact-compaction.js";

// Online, restartable cleanup. No schema migrations or rating recomputation.
// Freed pages become reusable immediately; shrinking the file is a separate,
// offline VACUUM INTO using the documented stop/socket/swap procedure.
if (process.argv.length > 2) throw new Error("This command takes no arguments; see docs/backend.md for offline vacuuming.");
const config = readConfig();
const db = await createRuntimeDb({ ...config, sqliteCacheMb: 16, sqliteMmapMb: 0 });
let lastLog = 0;
try {
  const results = await compactLnArtifacts(db, {
    onProgress: (progress) => {
      if (Date.now() - lastLog < 10_000) return;
      lastLog = Date.now();
      logInfo("ln_artifact_compaction_progress", { ...progress });
    },
  });
  logInfo("ln_artifact_compaction_complete", { results });
} finally {
  db.close();
}
