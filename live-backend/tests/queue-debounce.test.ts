import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, exec, migrate } from "../src/db.js";
import { JobQueue } from "../src/jobs/queue.js";

async function readRunAfter(db: Awaited<ReturnType<typeof createDb>>, dedupeKey: string): Promise<string> {
  const row = (await exec(db, "select run_after from jobs where dedupe_key = ?", [dedupeKey])).rows[0];
  return String(row?.run_after ?? "");
}

describe("job queue debounce merge", () => {
  it("debounced re-enqueues push run_after out; a plain enqueue pulls it forward", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mania-live-queue-"));
    try {
      const db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
      await migrate(db);
      const queue = new JobQueue(db);

      const t1 = new Date(Date.now() + 60_000);
      await queue.enqueue("compute_player_skills", "k", { userId: 1 }, { runAfter: t1, debounce: true, priority: 15 });
      expect(await readRunAfter(db, "k")).toBe(t1.toISOString());

      // Later event during the same session: the timer extends (max), it does
      // not snap back to the earlier deadline.
      const t2 = new Date(Date.now() + 120_000);
      await queue.enqueue("compute_player_skills", "k", { userId: 1 }, { runAfter: t2, debounce: true, priority: 15 });
      expect(await readRunAfter(db, "k")).toBe(t2.toISOString());

      // A debounced enqueue with an EARLIER deadline must not pull the job
      // forward either — max keeps the later one.
      await queue.enqueue("compute_player_skills", "k", { userId: 1 }, { runAfter: t1, debounce: true, priority: 15 });
      expect(await readRunAfter(db, "k")).toBe(t2.toISOString());

      // A plain (non-debounced) enqueue — e.g. a viewer opening the profile —
      // takes min and makes the job due now, and priority takes max.
      const now = new Date();
      await queue.enqueue("compute_player_skills", "k", { userId: 1 }, { runAfter: now, priority: 50 });
      expect(await readRunAfter(db, "k")).toBe(now.toISOString());
      const row = (await exec(db, "select priority from jobs where dedupe_key = 'k'")).rows[0];
      expect(Number(row?.priority)).toBe(50);

      const claimed = await queue.claim("test-worker", 1, { types: ["compute_player_skills"] });
      expect(claimed.length).toBe(1);
      db.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // Two hydration paths (enrich_user and enrich_beatmap) replay the same score
  // and re-request the same seed job. The second request must not read the job
  // it is re-requesting as pressure: on a reserve-1 lane that deferred the seed
  // by the full pressure window, and the snipe it was seeding never landed.
  it("does not defer a reserved-lane job against its own queued row", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mania-live-queue-"));
    try {
      const db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
      await migrate(db);
      const queue = new JobQueue(db);

      const payload = { country: "CR", beatmapId: 502, laneKey: "normal:lazer" };
      await queue.enqueue("seed_snipe_board", "snipe-seed:CR:502:normal:lazer", payload, { priority: 40 });
      await queue.enqueue("seed_snipe_board", "snipe-seed:CR:502:normal:lazer", payload, { priority: 40 });
      const row = (await exec(db, "select status from jobs where dedupe_key = 'snipe-seed:CR:502:normal:lazer'")).rows[0];
      expect(String(row?.status)).toBe("queued");

      // A DIFFERENT seed job still respects the reserve while that one is due.
      await queue.enqueue("seed_snipe_board", "snipe-seed:CR:503:normal:lazer", { ...payload, beatmapId: 503 }, { priority: 40 });
      const other = (await exec(db, "select status from jobs where dedupe_key = 'snipe-seed:CR:503:normal:lazer'")).rows[0];
      expect(String(other?.status)).toBe("deferred_pressure");
      db.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
