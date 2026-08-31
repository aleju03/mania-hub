import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, exec, migrate } from "../src/db.js";
import { JobQueue } from "../src/jobs/queue.js";
import { defaultWorkerLanes } from "../src/workers.js";

type Db = Awaited<ReturnType<typeof createDb>>;

async function withDb(run: (db: Db, queue: JobQueue) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "mania-live-lanes-"));
  try {
    const db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
    await migrate(db);
    await run(db, new JobQueue(db));
    db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function enqueueRoster(queue: JobQueue, country: string, priority: number): Promise<void> {
  await queue.enqueue("refresh_country_roster", `roster:${country}`, { country }, { priority });
}

describe("worker lanes for reserved types", () => {
  const lanes = defaultWorkerLanes();
  const laneNames = (type: string) => lanes.filter((lane) => lane.jobTypes?.includes(type)).map((lane) => lane.name);

  // Both guarantees at once: a dedicated lane so scheduled work always drains,
  // and a fast-lane seat so an admitted urgent job runs immediately.
  it("gives rosters a dedicated lane while keeping them in fast", () => {
    expect(laneNames("refresh_country_roster")).toEqual(["fast", "country-rosters"]);
  });

  it("claims a roster even while higher-priority fast work floods the queue", async () => {
    await withDb(async (_db, queue) => {
      await enqueueRoster(queue, "LI", 10);
      for (let i = 0; i < 20; i += 1) {
        await queue.enqueue("refresh_profile_user", `profile:${i}`, { userId: i }, { priority: 120 });
      }
      const fast = lanes.find((lane) => lane.name === "fast")!;
      expect((await queue.claim("fast-worker", fast.claimLimit, { types: fast.jobTypes })).every((job) => job.type === "refresh_profile_user")).toBe(true);

      const rosterLane = lanes.find((lane) => lane.name === "country-rosters")!;
      const claimed = await queue.claim("roster-worker", rosterLane.claimLimit, { types: rosterLane.jobTypes });
      expect(claimed.map((job) => job.dedupeKey)).toEqual(["roster:LI"]);
    });
  });
});
