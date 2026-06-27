import type { Db } from "../db.js";
import { exec } from "../db.js";
import type { OsuApiClient } from "./client.js";
import { nowIso } from "../shared/score.js";

// Persistent cache for raw .osu files. The dan estimator and activity analyzer
// both download and parse a chart's .osu file; without this they re-fetch from
// osu.ppy.sh every time a map is computed cold (including after a cache-version
// bump that recomputes every dan). The dan/activity RESULTS are already cached in
// their own tables, so this only fires on a genuine cold parse, but it keeps
// those cold paths off the rate-limited osu! API. Stored rows are pruned by
// retention and bounded by the global DB size cap.

// Treat a cached file as good for this long. .osu files are immutable per
// beatmap id in practice (a real edit gets a new id), so this is mostly a
// freshness backstop rather than a correctness requirement.
const MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

export async function getCachedBeatmapFile(
  db: Db,
  osu: Pick<OsuApiClient, "getBeatmapFile">,
  beatmapId: number,
  caller: string,
): Promise<string> {
  const safeId = Math.floor(beatmapId);
  if (!Number.isFinite(safeId) || safeId <= 0) throw new Error("Invalid beatmap ID");

  const cached = await readCachedFile(db, safeId);
  if (cached) return cached;

  const content = await osu.getBeatmapFile(safeId, caller);
  // Best-effort store: a failed write must not fail the compute that needs the
  // file, so swallow write errors (e.g. a transient DB lock).
  await storeFile(db, safeId, content).catch(() => {});
  return content;
}

async function readCachedFile(db: Db, beatmapId: number): Promise<string | null> {
  const row = (await exec(
    db,
    "select content, fetched_at from beatmap_osu_files where beatmap_id = ? limit 1",
    [beatmapId],
  ).catch(() => ({ rows: [] as Record<string, unknown>[] }))).rows[0];
  if (!row) return null;
  const fetchedAt = Date.parse(String(row.fetched_at ?? ""));
  if (Number.isFinite(fetchedAt) && Date.now() - fetchedAt > MAX_AGE_MS) return null;
  const content = row.content == null ? "" : String(row.content);
  return content.length ? content : null;
}

async function storeFile(db: Db, beatmapId: number, content: string): Promise<void> {
  if (!content) return;
  await exec(
    db,
    `insert into beatmap_osu_files (beatmap_id, content, fetched_at)
     values (?, ?, ?)
     on conflict(beatmap_id) do update set content = excluded.content, fetched_at = excluded.fetched_at`,
    [beatmapId, content, nowIso()],
  );
}
