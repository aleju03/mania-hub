import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, exec, migrate } from "../src/db.js";
import { extractBeatmapOsuFileFromArchive } from "../src/audio/beatmap-archive.js";
import { getCachedBeatmapFile, readCachedBeatmapFile, storeCachedBeatmapFile } from "../src/osu/beatmap-file-cache.js";

vi.mock("../src/audio/beatmap-archive.js", () => ({
  extractBeatmapOsuFileFromArchive: vi.fn(),
}));

describe("beatmap .osu file cache", () => {
  beforeEach(() => {
    vi.mocked(extractBeatmapOsuFileFromArchive).mockReset();
  });

  it("stores fetched .osu files as compressed blobs and serves later reads from DB", async () => {
    const { db, cleanup } = await setupDb();
    try {
      const osuFile = buildBeatmapFile();
      let fetchCount = 0;
      const osu = {
        getBeatmapFile: async () => {
          fetchCount++;
          return osuFile;
        },
      };

      await expect(getCachedBeatmapFile(db, osu, 123, "test:first")).resolves.toBe(osuFile);
      await expect(getCachedBeatmapFile(db, osu, 123, "test:second")).resolves.toBe(osuFile);
      expect(fetchCount).toBe(1);

      const row = (await exec(
        db,
        "select compression, content, raw_bytes, compressed_bytes, length(content_blob) as blob_bytes from beatmap_osu_files where beatmap_id = 123",
      )).rows[0];
      expect(row.compression).toBe("gzip");
      expect(row.content).toBe("");
      expect(Number(row.raw_bytes)).toBe(Buffer.byteLength(osuFile, "utf8"));
      expect(Number(row.compressed_bytes)).toBe(Number(row.blob_bytes));
      expect(Number(row.compressed_bytes)).toBeLessThan(Number(row.raw_bytes));
    } finally {
      await cleanup();
    }
  });

  it("reads legacy raw-text rows and upgrades them to compressed storage", async () => {
    const { db, cleanup } = await setupDb();
    try {
      const osuFile = buildBeatmapFile();
      await exec(
        db,
        `insert into beatmap_osu_files (beatmap_id, content, fetched_at, last_used_at)
         values (456, ?, '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z')`,
        [osuFile],
      );

      await expect(readCachedBeatmapFile(db, 456)).resolves.toBe(osuFile);

      const row = (await exec(
        db,
        "select content, raw_bytes, compressed_bytes, length(content_blob) as blob_bytes from beatmap_osu_files where beatmap_id = 456",
      )).rows[0];
      expect(row.content).toBe("");
      expect(Number(row.raw_bytes)).toBe(Buffer.byteLength(osuFile, "utf8"));
      expect(Number(row.compressed_bytes)).toBe(Number(row.blob_bytes));
      expect(Number(row.compressed_bytes)).toBeGreaterThan(0);
    } finally {
      await cleanup();
    }
  });

  it("stores archive .osu files without calling the direct osu API", async () => {
    const { db, cleanup } = await setupDb();
    try {
      const osuFile = buildBeatmapFile();
      vi.mocked(extractBeatmapOsuFileFromArchive).mockResolvedValueOnce({
        path: "Artist - Title (Mapper) [Archive 4K].osu",
        text: osuFile,
      });
      const osu = {
        getBeatmapFile: vi.fn(async () => buildBeatmapFile()),
      };

      await insertBeatmapMeta(db, 789, 456, "Archive 4K");
      await expect(getCachedBeatmapFile(db, osu, 789, "test:archive", { allowArchive: true })).resolves.toBe(osuFile);

      expect(osu.getBeatmapFile).not.toHaveBeenCalled();
      expect(extractBeatmapOsuFileFromArchive).toHaveBeenCalledWith("456", 789, { version: "Archive 4K" });
      const row = (await exec(
        db,
        "select beatmapset_id, source, compressed_bytes from beatmap_osu_files where beatmap_id = 789",
      )).rows[0];
      expect(Number(row.beatmapset_id)).toBe(456);
      expect(row.source).toBe("beatmap_archive");
      expect(Number(row.compressed_bytes)).toBeGreaterThan(0);
    } finally {
      await cleanup();
    }
  });

  it("serves the cached copy when the expected checksum matches", async () => {
    const { db, cleanup } = await setupDb();
    try {
      const osuFile = buildBeatmapFile();
      const osu = { getBeatmapFile: vi.fn(async () => osuFile) };

      await getCachedBeatmapFile(db, osu, 900, "test:seed");
      const served = await getCachedBeatmapFile(db, osu, 900, "test:checked", {
        expectedChecksum: md5(osuFile),
      });

      expect(served).toBe(osuFile);
      expect(osu.getBeatmapFile).toHaveBeenCalledOnce();
    } finally {
      await cleanup();
    }
  });

  it("refetches a cached copy whose checksum no longer matches", async () => {
    const { db, cleanup } = await setupDb();
    try {
      const staleFile = buildBeatmapFile();
      const currentFile = `${buildBeatmapFile()}\n// updated revision\n`;
      const osu = { getBeatmapFile: vi.fn(async () => currentFile) };

      await exec(
        db,
        "insert into beatmap_osu_files (beatmap_id, content, fetched_at, last_used_at) values (901, ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
        [staleFile],
      );

      const served = await getCachedBeatmapFile(db, osu, 901, "test:refresh", {
        expectedChecksum: md5(currentFile),
      });

      expect(served).toBe(currentFile);
      expect(osu.getBeatmapFile).toHaveBeenCalledOnce();
      await expect(readCachedBeatmapFile(db, 901)).resolves.toBe(currentFile);
    } finally {
      await cleanup();
    }
  });

  it("throttles checksum refetches by fetched_at and serves the stale copy meanwhile", async () => {
    const { db, cleanup } = await setupDb();
    try {
      const staleFile = buildBeatmapFile();
      const seedOsu = { getBeatmapFile: vi.fn(async () => staleFile) };
      const refreshOsu = { getBeatmapFile: vi.fn(async () => `${staleFile}updated`) };

      // Freshly stored (fetched_at = now): a mismatching checksum must not
      // trigger another osu! API call yet.
      await getCachedBeatmapFile(db, seedOsu, 902, "test:seed");

      const served = await getCachedBeatmapFile(db, refreshOsu, 902, "test:throttled", {
        expectedChecksum: "0123456789abcdef0123456789abcdef",
      });

      expect(served).toBe(staleFile);
      expect(refreshOsu.getBeatmapFile).not.toHaveBeenCalled();
    } finally {
      await cleanup();
    }
  });

  it("serves the stale copy when the checksum refetch fails or is disallowed", async () => {
    const { db, cleanup } = await setupDb();
    try {
      const staleFile = buildBeatmapFile();
      const failingOsu = { getBeatmapFile: vi.fn(async () => { throw new Error("osu down"); }) };

      await exec(
        db,
        "insert into beatmap_osu_files (beatmap_id, content, fetched_at, last_used_at) values (903, ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
        [staleFile],
      );

      await expect(getCachedBeatmapFile(db, failingOsu, 903, "test:failed", {
        expectedChecksum: "0123456789abcdef0123456789abcdef",
      })).resolves.toBe(staleFile);
      expect(failingOsu.getBeatmapFile).toHaveBeenCalledOnce();

      const cachedOnlyOsu = { getBeatmapFile: vi.fn(async () => "unused") };
      await expect(getCachedBeatmapFile(db, cachedOnlyOsu, 903, "test:cached-only", {
        allowDirect: false,
        expectedChecksum: "0123456789abcdef0123456789abcdef",
      })).resolves.toBe(staleFile);
      expect(cachedOnlyOsu.getBeatmapFile).not.toHaveBeenCalled();
    } finally {
      await cleanup();
    }
  });

  it("skips a stale archive copy on a cache miss when the checksum mismatches", async () => {
    const { db, cleanup } = await setupDb();
    try {
      const staleFile = buildBeatmapFile();
      const currentFile = `${buildBeatmapFile()}\n// updated revision\n`;
      vi.mocked(extractBeatmapOsuFileFromArchive).mockResolvedValueOnce({
        path: "Artist - Title (Mapper) [Stale 4K].osu",
        text: staleFile,
      });
      const osu = { getBeatmapFile: vi.fn(async () => currentFile) };

      await insertBeatmapMeta(db, 910, 500, "Stale 4K");
      const served = await getCachedBeatmapFile(db, osu, 910, "test:stale-archive", {
        allowArchive: true,
        expectedChecksum: md5(currentFile),
      });

      expect(served).toBe(currentFile);
      expect(osu.getBeatmapFile).toHaveBeenCalledOnce();
      await expect(readCachedBeatmapFile(db, 910)).resolves.toBe(currentFile);
    } finally {
      await cleanup();
    }
  });

  it("uses the archive copy on a cache miss when its checksum matches", async () => {
    const { db, cleanup } = await setupDb();
    try {
      const osuFile = buildBeatmapFile();
      vi.mocked(extractBeatmapOsuFileFromArchive).mockResolvedValueOnce({
        path: "Artist - Title (Mapper) [Match 4K].osu",
        text: osuFile,
      });
      const osu = { getBeatmapFile: vi.fn(async () => osuFile) };

      await insertBeatmapMeta(db, 911, 501, "Match 4K");
      const served = await getCachedBeatmapFile(db, osu, 911, "test:matching-archive", {
        allowArchive: true,
        expectedChecksum: md5(osuFile),
      });

      expect(served).toBe(osuFile);
      expect(osu.getBeatmapFile).not.toHaveBeenCalled();
    } finally {
      await cleanup();
    }
  });

  it("falls back to the mismatching archive copy when the direct fetch fails", async () => {
    const { db, cleanup } = await setupDb();
    try {
      const staleFile = buildBeatmapFile();
      vi.mocked(extractBeatmapOsuFileFromArchive).mockResolvedValueOnce({
        path: "Artist - Title (Mapper) [Fallback 4K].osu",
        text: staleFile,
      });
      const osu = { getBeatmapFile: vi.fn(async () => { throw new Error("osu down"); }) };

      await insertBeatmapMeta(db, 912, 502, "Fallback 4K");
      const served = await getCachedBeatmapFile(db, osu, 912, "test:archive-fallback", {
        allowArchive: true,
        expectedChecksum: "0123456789abcdef0123456789abcdef",
      });

      expect(served).toBe(staleFile);
      expect(osu.getBeatmapFile).toHaveBeenCalledOnce();
      await expect(readCachedBeatmapFile(db, 912)).resolves.toBe(staleFile);
    } finally {
      await cleanup();
    }
  });

  it("throttles repeated refresh attempts after a failed refetch", async () => {
    const { db, cleanup } = await setupDb();
    try {
      const staleFile = buildBeatmapFile();
      const osu = { getBeatmapFile: vi.fn(async () => { throw new Error("osu down"); }) };

      // Seed a compressed row and backdate fetched_at: a legacy raw row would
      // get re-stored with a fresh fetched_at on first read, which would mask
      // the in-memory failure throttle this test is about.
      await storeCachedBeatmapFile(db, 913, staleFile);
      await exec(db, "update beatmap_osu_files set fetched_at = '2026-01-01T00:00:00.000Z' where beatmap_id = 913");

      const options = { expectedChecksum: "0123456789abcdef0123456789abcdef" };
      await expect(getCachedBeatmapFile(db, osu, 913, "test:first-failure", options)).resolves.toBe(staleFile);
      await expect(getCachedBeatmapFile(db, osu, 913, "test:throttled-failure", options)).resolves.toBe(staleFile);

      // The row's fetched_at is still old, so only the in-memory failure
      // timestamp explains the second call not reaching the API.
      expect(osu.getBeatmapFile).toHaveBeenCalledOnce();
    } finally {
      await cleanup();
    }
  });

  it("falls back to direct osu fetches when archive extraction fails", async () => {
    const { db, cleanup } = await setupDb();
    try {
      const osuFile = buildBeatmapFile();
      vi.mocked(extractBeatmapOsuFileFromArchive).mockRejectedValueOnce(new Error("archive unavailable"));
      const osu = {
        getBeatmapFile: vi.fn(async () => osuFile),
      };

      await insertBeatmapMeta(db, 790, 457, "Direct 4K");
      await expect(getCachedBeatmapFile(db, osu, 790, "test:direct", { allowArchive: true })).resolves.toBe(osuFile);

      expect(osu.getBeatmapFile).toHaveBeenCalledOnce();
      const row = (await exec(
        db,
        "select beatmapset_id, source, compressed_bytes from beatmap_osu_files where beatmap_id = 790",
      )).rows[0];
      expect(Number(row.beatmapset_id)).toBe(457);
      expect(row.source).toBe("osu_api");
      expect(Number(row.compressed_bytes)).toBeGreaterThan(0);
    } finally {
      await cleanup();
    }
  });
});

async function setupDb(): Promise<{ db: Awaited<ReturnType<typeof createDb>>; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "mania-live-osu-cache-"));
  const db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
  await migrate(db);
  return {
    db,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

function md5(content: string): string {
  return createHash("md5").update(content, "utf8").digest("hex");
}

function buildBeatmapFile(): string {
  const notes = Array.from({ length: 512 }, (_, index) => {
    const column = index % 4;
    const x = 64 + column * 128;
    const time = 1000 + index * 95;
    return `${x},192,${time},${index % 7 === 0 ? 128 : 1},0,${time + 240}:0:0:0:0:`;
  }).join("\n");
  return `osu file format v14

[General]
AudioFilename: audio.mp3
Mode: 3

[Metadata]
Title: Cache Test
Artist: Test
Creator: Mapper
Version: 4K
BeatmapID:123

[Difficulty]
CircleSize:4
OverallDifficulty:8

[TimingPoints]
0,500,4,2,0,100,1,0

[HitObjects]
${notes}
`;
}

async function insertBeatmapMeta(db: Awaited<ReturnType<typeof createDb>>, beatmapId: number, beatmapsetId: number, version: string): Promise<void> {
  await exec(
    db,
    `insert into beatmaps (
       beatmap_id, beatmapset_id, mode, status, cs, difficulty_rating, bpm,
       max_combo, version, url, metadata_json, updated_at
     )
     values (?, ?, 'mania', 'ranked', 4, 1, 180, 1000, ?, null, null, '2026-01-01T00:00:00.000Z')`,
    [beatmapId, beatmapsetId, version],
  );
}
