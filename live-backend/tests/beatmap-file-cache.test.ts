import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, exec, migrate } from "../src/db.js";
import { getCachedBeatmapFile, readCachedBeatmapFile } from "../src/osu/beatmap-file-cache.js";

describe("beatmap .osu file cache", () => {
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
