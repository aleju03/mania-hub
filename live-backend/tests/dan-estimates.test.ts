import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, migrate } from "../src/db.js";
import { DAN_ESTIMATE_CACHE_VERSION } from "../src/dan/dan-estimator/cache-version.js";
import { getDanEstimateBatch, normalizeDanEstimateItems } from "../src/features/dan-estimates.js";
import { JobQueue } from "../src/jobs/queue.js";

describe("normalizeDanEstimateItems", () => {
  it("deduplicates response keys and clamps unusual rates", () => {
    expect(normalizeDanEstimateItems([
      { beatmapId: 123, starRating: 5.4 },
      { beatmapId: 123, rate: 1 },
      { beatmapId: 456, rate: 2.5 },
      { beatmapId: 789, rate: 0.2 },
      { beatmapId: "nope" },
    ])).toEqual([
      { beatmapId: 123, starRating: 5.4, rate: 1, ratePercent: 100, key: "123" },
      { beatmapId: 456, starRating: undefined, rate: 2, ratePercent: 200, key: "456:200" },
      { beatmapId: 789, starRating: undefined, rate: 0.5, ratePercent: 50, key: "789:50" },
    ]);
  });

  it("computes a missing 4K estimate once and then serves it from cache", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mania-live-dan-"));
    try {
      const db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
      await migrate(db);
      const queue = new JobQueue(db);
      let fetchCount = 0;
      const osu = {
        getBeatmapFile: async () => {
          fetchCount++;
          return buildFourKeyBeatmapFile();
        },
      };

      const first = await getDanEstimateBatch(db, queue, osu as never, [{ beatmapId: 123, starRating: 4.2 }], { computeMissing: true });
      expect(first.pending).toEqual([]);
      expect(first.results["123"]?.estimatorVersion).toBe(DAN_ESTIMATE_CACHE_VERSION);
      expect(fetchCount).toBe(1);

      const second = await getDanEstimateBatch(db, queue, osu as never, [{ beatmapId: 123, starRating: 4.2 }], { computeMissing: false });
      expect(second.pending).toEqual([]);
      expect(second.results["123"]).toEqual(first.results["123"]);
      expect(fetchCount).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

function buildFourKeyBeatmapFile(): string {
  const notes = Array.from({ length: 96 }, (_, index) => {
    const column = index % 4;
    const x = 64 + column * 128;
    const time = 1000 + index * 110;
    return `${x},192,${time},1,0,0:0:0:0:`;
  }).join("\n");
  return `osu file format v14

[General]
AudioFilename: audio.mp3
Mode: 3

[Metadata]
Title: Test Dan
Artist: Test
Creator: Mapper
Version: 4K

[Difficulty]
CircleSize:4
OverallDifficulty:8

[TimingPoints]
0,500,4,2,0,100,1,0

[HitObjects]
${notes}
`;
}
