import type { Db } from "../db.js";
import { exec } from "../db.js";
import { logWarn } from "../logger.js";
import { nowIso } from "../shared/score.js";
import { validateOskBuffer } from "./validate-osk.js";

// v2: v1 shipped with a 2-unit minimum line width, which missed skins that
// mark the scratch lane with a single 1-unit line (pl0x). Bumping the marker
// re-runs the scan once with the relaxed rule.
const META_KEY = "skin_special_keymodes_backfill:v2";

// One-time classification of skins uploaded before 7K+1 detection existed:
// re-reads each stored .osk's skin.ini and records which keymodes are really
// (N-1)+1 layouts. Purely additive metadata - the archives, previews, and
// declared keymodes of the existing catalog are never touched. Downloads run
// one at a time, so the caller fires this behind boot rather than awaiting it.
// The one-shot marker lands only when no row failed to classify: a partial
// failure (one broken archive would stall it forever) is accepted and logged,
// but a pass where every read failed - storage down at boot - retries next
// boot instead of freezing the whole catalog as unclassified.
export async function backfillSkinSpecialKeymodes(
  db: Db,
  readOsk: (key: string) => Promise<Buffer | null>,
): Promise<number> {
  const done = (await exec(db, "select 1 from live_meta where key = ? limit 1", [META_KEY])).rows[0];
  if (done) return 0;
  const rows = (await exec(
    db,
    "select id, osk_key from skins where status != 'pending' and osk_key is not null",
  )).rows;
  let updated = 0;
  let failed = 0;
  for (const row of rows) {
    const id = String(row.id);
    const buffer = await readOsk(String(row.osk_key)).catch(() => null);
    const validation = buffer ? await validateOskBuffer(buffer) : null;
    if (!validation?.ok) {
      failed += 1;
      logWarn("skin_special_keymodes_unreadable", { id, reason: validation ? validation.error : "osk_read_failed" });
      continue;
    }
    if (validation.info.specialKeymodes.length === 0) continue;
    await exec(
      db,
      "update skins set special_keymodes_json = ?, updated_at = ? where id = ?",
      [JSON.stringify(validation.info.specialKeymodes), nowIso(), id],
    );
    updated += 1;
  }
  const allFailed = rows.length > 0 && failed === rows.length;
  if (!allFailed) {
    await exec(
      db,
      "insert or replace into live_meta (key, value_json, updated_at) values (?, ?, ?)",
      [META_KEY, JSON.stringify({ scanned: rows.length, updated, failed }), nowIso()],
    );
  }
  return updated;
}
