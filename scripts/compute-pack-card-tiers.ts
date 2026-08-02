/* Computes every tracked player's maniacard tier and writes it to the live
   backend, so packs can draw by rarity instead of inheriting whatever the pool
   happens to contain.

   The tier algorithm (computeManiaSkills + getManiaCardTier) lives in
   src/lib/maniacard.ts and is deliberately not duplicated backend-side, so this
   script is the bridge: it reads each player's stored top-score window and
   beatmap difficulty straight from the backend's SQLite file, runs the real
   algorithm, and posts results to /api/admin/card-tiers.

   Re-run it after the pool drifts (new players, pp changes). A stale tier only
   skews draw odds slightly - the tier a card renders with is always recomputed
   from live scores at reveal time.

   Usage:
     LIVE_ADMIN_TOKEN=... npx tsx scripts/compute-pack-card-tiers.ts
     npx tsx scripts/compute-pack-card-tiers.ts --dry-run
     npx tsx scripts/compute-pack-card-tiers.ts --direct   # write to the DB file
*/
import { DatabaseSync } from "node:sqlite";
import { gunzipSync } from "node:zlib";
import { computeManiaSkills, getManiaCardTier } from "../src/lib/maniacard";

const DB_PATH = process.env.LIVE_DB_PATH ?? "live-backend/data/mania-hub-live.db";
const BACKEND_URL = process.env.LIVE_BACKEND_URL ?? "http://localhost:7227";
const BATCH = 500;
const dryRun = process.argv.includes("--dry-run");
// --direct writes straight to the SQLite file instead of through the admin
// endpoint: useful on the VPS, and the only option when the running backend
// predates the endpoint.
const direct = process.argv.includes("--direct");

/* Stored score rows are gzipped JSON on newer writes and plain text on older
   ones; mirrors unpackJson in live-backend/src/shared/compressed-json.ts. */
function unpack<T>(value: unknown, fallback: T): T {
  try {
    if (value == null) return fallback;
    if (typeof value === "string") return JSON.parse(value) as T;
    const buffer = Buffer.from(value as ArrayBuffer);
    if (buffer[0] === 0x1f && buffer[1] === 0x8b) return JSON.parse(gunzipSync(buffer).toString("utf8")) as T;
    return JSON.parse(buffer.toString("utf8")) as T;
  } catch {
    return fallback;
  }
}

async function main() {
  // The backend may be serving from this same file; WAL handles the overlap.
  const db = new DatabaseSync(DB_PATH, { readOnly: !direct });
  if (direct) db.exec("pragma busy_timeout = 15000");

  const boardRow = db.prepare("select value_json from live_meta where key = 'global_board_pack'").get() as { value_json: string } | undefined;
  if (!boardRow) throw new Error("No global_board_pack in live_meta; the pool has never been built.");
  const board = JSON.parse(
    gunzipSync(Buffer.from((JSON.parse(String(boardRow.value_json)) as { gzip: string }).gzip, "base64")).toString("utf8"),
  ) as { entries: Array<{ user: { id: number }; pp: number }> };
  const poolIds = board.entries.map((entry) => entry.user.id);
  const ppById = new Map(board.entries.map((entry) => [entry.user.id, entry.pp]));
  console.log(`pool: ${poolIds.length} players`);

  // Stored scores carry beatmap_id only; difficulty lives in `beatmaps`.
  const beatmaps = new Map<number, Record<string, unknown>>();
  for (const row of db.prepare("select beatmap_id, metadata_json from beatmaps where metadata_json is not null").all() as Array<Record<string, unknown>>) {
    try {
      beatmaps.set(Number(row.beatmap_id), JSON.parse(String(row.metadata_json)));
    } catch { /* a malformed row just costs that map's scores */ }
  }
  console.log(`beatmaps with difficulty metadata: ${beatmaps.size}`);

  const computed: Array<{ userId: number; tier: string; cardPower: number }> = [];
  let noSnapshot = 0;
  let noSkills = 0;

  for (let start = 0; start < poolIds.length; start += 200) {
    const ids = poolIds.slice(start, start + 200);
    const rows = db
      .prepare(`select user_id, best_scores_json from profile_snapshots where user_id in (${ids.map(() => "?").join(",")})`)
      .all(...ids) as Array<Record<string, unknown>>;

    const seen = new Set<number>();
    for (const row of rows) {
      const userId = Number(row.user_id);
      seen.add(userId);
      const stored = unpack<Record<string, unknown>[]>(row.best_scores_json, []);
      if (!Array.isArray(stored) || stored.length === 0) { noSkills += 1; continue; }
      const scores = stored
        .map((score) => {
          const beatmap = beatmaps.get(Number(score.beatmap_id));
          return beatmap ? { ...score, beatmap } : null;
        })
        .filter(Boolean);
      if (scores.length === 0) { noSkills += 1; continue; }
      const skills = computeManiaSkills(scores as never, { globalPp: ppById.get(userId) });
      if (!skills) { noSkills += 1; continue; }
      computed.push({ userId, tier: getManiaCardTier(skills.cardPower), cardPower: skills.cardPower });
    }
    noSnapshot += ids.filter((id) => !seen.has(id)).length;
  }

  const counts = new Map<string, number>();
  for (const entry of computed) counts.set(entry.tier, (counts.get(entry.tier) ?? 0) + 1);
  console.log(`\ncomputed ${computed.length} | no profile snapshot ${noSnapshot} | skills unavailable ${noSkills}`);
  console.log("\ntier population:");
  for (const [tier, n] of [...counts].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${tier.padEnd(11)} ${String(n).padStart(5)}  ${(n / computed.length * 100).toFixed(2)}%`);
  }

  if (dryRun) {
    console.log("\n--dry-run: nothing written");
    return;
  }

  if (direct) {
    const now = new Date().toISOString();
    const update = db.prepare(
      "update users set card_tier = ?, card_power = ?, card_tier_computed_at = ? where user_id = ?",
    );
    let touched = 0;
    db.exec("begin");
    for (const entry of computed) touched += update.run(entry.tier, entry.cardPower, now, entry.userId).changes > 0 ? 1 : 0;
    db.exec("commit");
    console.log(`\nwrote ${touched} tiers directly to ${DB_PATH}`);
    return;
  }

  const token = process.env.LIVE_ADMIN_TOKEN;
  if (!token) throw new Error("LIVE_ADMIN_TOKEN is required to write (or pass --dry-run or --direct).");

  let written = 0;
  for (let start = 0; start < computed.length; start += BATCH) {
    const entries = computed.slice(start, start + BATCH);
    const response = await fetch(`${BACKEND_URL}/api/admin/card-tiers`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ entries }),
    });
    if (!response.ok) throw new Error(`card-tiers write failed: ${response.status} ${await response.text()}`);
    written += ((await response.json()) as { written: number }).written;
  }
  console.log(`\nwrote ${written} tiers to ${BACKEND_URL}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
