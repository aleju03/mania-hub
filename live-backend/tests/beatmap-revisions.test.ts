import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, exec, migrate } from "../src/db.js";
import { OsuApiClient } from "../src/osu/client.js";
import { getCachedBeatmapFile } from "../src/osu/beatmap-file-cache.js";
import { JobQueue } from "../src/jobs/queue.js";
import { toStoredScoreEvent } from "../src/ingest/score-ingestor.js";
import type { OscScore } from "../src/shared/types.js";
import { beatmapFileMd5, storeCachedBeatmapFile } from "../src/osu/beatmap-file-cache.js";
import { auditBeatmapRevisions, enqueueBeatmapRevisionCheck, readBeatmapRevisionStates, seedBeatmapRevisionAudit, verifyBeatmapRevision } from "../src/osu/beatmap-revisions.js";

async function withDb(run: (db: Awaited<ReturnType<typeof createDb>>) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "mania-revision-"));
  const db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
  try { await migrate(db); await run(db); }
  finally { db.close(); await rm(dir, { recursive: true, force: true }); }
}

async function seed(db: Awaited<ReturnType<typeof createDb>>, id: number, status: string, checksum: string) {
  await exec(db, `insert into beatmaps (beatmap_id, beatmapset_id, mode, status, cs, version, metadata_json, updated_at)
    values (?, 1, 'mania', ?, 4, 'Chart', ?, ?)`,
  [id, status, JSON.stringify({ checksum, last_updated: "2026-09-16T09:00:00Z" }), new Date().toISOString()]);
}

it("preserves the observed checksum before compacting scores, without relabelling historical plays", () => {
  const score = { id: 1, ended_at: "2026-09-16T10:00:00Z", beatmap: { id: 10,
    checksum: "a".repeat(32), last_updated: "2026-09-16T09:00:00Z" } } as OscScore;
  expect(toStoredScoreEvent(score)).toMatchObject({ beatmapChecksum: "a".repeat(32) });
  expect(toStoredScoreEvent(score)).not.toHaveProperty("beatmap");
  expect(toStoredScoreEvent({ ...score, ended_at: "2026-09-15T10:00:00Z" })).not.toHaveProperty("beatmapChecksum");
  expect(toStoredScoreEvent({ ...score, started_at: "2026-09-16T08:59:00Z" })).not.toHaveProperty("beatmapChecksum");
  expect(toStoredScoreEvent({ ...score, beatmapChecksum: "b".repeat(32) }).beatmapChecksum).toBe("b".repeat(32));
});

describe("beatmap revision jobs", () => {
  it("preserves downloaded BOM bytes and heals old stripped caches without network or rerating", async () => {
    const file = "\uFEFFosu file format v14\n[HitObjects]\n";
    const fetchImpl = vi.fn(async () => new Response(file));
    const osu = new OsuApiClient({ osuClientId: "", osuClientSecret: "", osuApiHardPerMinute: 60, osuApiTargetPerMinute: 45 }, fetchImpl);
    expect(await osu.getBeatmapFile(10, "test:bom")).toBe(file);
    await withDb(async db => {
      await seed(db, 10, "wip", beatmapFileMd5(file));
      await storeCachedBeatmapFile(db, 10, file.slice(1));
      await exec(db, "update beatmap_osu_files set fetched_at = '2020-01-01T00:00:00Z' where beatmap_id = 10");
      const noFetch = { getBeatmapFile: vi.fn(async () => { throw new Error("must use cached bytes"); }) };
      expect(await getCachedBeatmapFile(db, noFetch, 10, "test:repair-bom")).toBe(file);
      expect(noFetch.getBeatmapFile).not.toHaveBeenCalled();
      expect((await exec(db, "select fetched_at, content_md5 from beatmap_osu_files where beatmap_id = 10")).rows)
        .toEqual([{ fetched_at: "2020-01-01T00:00:00Z", content_md5: beatmapFileMd5(file) }]);
      expect((await exec(db, "select type from jobs")).rows).toEqual([]);
    });
  });

  it("deduplicates refreshes without shortening backoff, then uses the newest metadata at execution", async () => {
    await withDb(async db => {
      const current = "osu file format v14\n// latest revision";
      await seed(db, 10, "wip", "a".repeat(32));
      await storeCachedBeatmapFile(db, 10, "old");
      await exec(db, "update beatmap_osu_files set fetched_at = '2020-01-01T00:00:00Z' where beatmap_id = 10");
      const queue = new JobQueue(db);
      await enqueueBeatmapRevisionCheck(db, queue, 10);
      await exec(db, "update jobs set status = 'failed', run_after = '2099-01-01T00:00:00Z'");
      await enqueueBeatmapRevisionCheck(db, queue, 10);
      expect((await exec(db, "select status, run_after from jobs")).rows).toEqual([{ status: "failed", run_after: "2099-01-01T00:00:00Z" }]);
      await exec(db, "update beatmaps set metadata_json = ? where beatmap_id = 10", [JSON.stringify({ checksum: beatmapFileMd5(current) })]);
      const osu = { getBeatmapFile: vi.fn(async () => current) };
      await verifyBeatmapRevision(db, osu, queue, 10);
      expect(osu.getBeatmapFile).toHaveBeenCalledOnce();
      expect((await exec(db, "select type from jobs where type = 'repair_changed_beatmap_file'")).rows).toHaveLength(1);
      expect((await readBeatmapRevisionStates(db, [10])).get(10)).toMatchObject({ fileChecksum: beatmapFileMd5(current), ready: false });
    });
  });

  it("audits existing editable files without downloading and seeds only once", async () => {
    await withDb(async db => {
      for (const [id, status, text] of [[10, "wip", "old"], [11, "ranked", "old"], [12, "pending", "current"]] as const) {
        await seed(db, id, status, beatmapFileMd5("current"));
        await storeCachedBeatmapFile(db, id, text);
      }
      const queue = new JobQueue(db);
      await seedBeatmapRevisionAudit(db, queue);
      await seedBeatmapRevisionAudit(db, queue);
      expect((await exec(db, "select type from jobs")).rows).toHaveLength(1);
      await auditBeatmapRevisions(db, queue, 0);
      const checks = (await exec(db, "select payload_json from jobs where type = 'verify_beatmap_revision'")).rows;
      expect(checks.map(row => JSON.parse(String(row.payload_json)))).toEqual([{ beatmapId: 10 }]);
      await exec(db, "delete from jobs");
      await seedBeatmapRevisionAudit(db, queue);
      expect((await exec(db, "select type from jobs")).rows).toHaveLength(0);
    });
  });

  it("uses content provenance after a same-file cache refresh and rejects obsolete analysis", async () => {
    await withDb(async db => {
      const checksum = beatmapFileMd5("current");
      await seed(db, 10, "wip", checksum);
      await storeCachedBeatmapFile(db, 10, "current");
      await exec(db, `insert into beatmap_chart_analysis
        (beatmap_id, analysis_version, status, computed_at, updated_at, source_file_md5)
        values (10, 1, 'ready', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z', ?)`, [checksum]);
      expect((await readBeatmapRevisionStates(db, [10])).get(10)?.ready).toBe(true);
      await exec(db, "update beatmap_chart_analysis set source_file_md5 = ?", ["b".repeat(32)]);
      expect((await readBeatmapRevisionStates(db, [10])).get(10)?.ready).toBe(false);
    });
  });
});
