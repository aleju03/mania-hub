import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, exec, migrate, type Db } from "../src/db.js";
import { JobQueue } from "../src/jobs/queue.js";
import { settlePlayerSkillContinuations, withPlayerSkillTurn } from "../src/features/player-skill-jobs.js";

async function withDb(run: (db: Db, queue: JobQueue) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "skill-jobs-"));
  const db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
  try {
    await migrate(db);
    await run(db, new JobQueue(db));
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
}

const progress = { rateVibroPending: 3, calibrationPending: 40, lnPending: 20, lnMigrationProgress: "100:120" };
const done = { rateVibroPending: 0, calibrationPending: 0, lnPending: 0, lnMigrationProgress: "120:140" };

describe("player skill continuations", () => {
  it("replaces all legacy budgets with one follow-up, preserving wakeups, leases and newer work", async () => {
    await withDb(async (db, queue) => {
      const keys = ["player-skills:40:99:ln:10:20", "player-skills:40:99:wife:100", "player-skills-rate-vibro:7:99:10",
        "player-skills:40:99", "player-skills:40:999:wife:100", "player-skills:39:99:wife:100",
        "player-skills:40:99:ln:30:40", "player-skills:40:99:wife:90"];
      for (const key of keys) await queue.enqueue("compute_player_skills", key, { userId: 99 });
      await exec(db, "update jobs set updated_at = '2026-01-01T00:00:00.000Z'");
      await exec(db, "update jobs set status = 'running', locked_by = 'worker', locked_until = '2099-01-01' where dedupe_key = ?", [keys[6]]);
      await exec(db, "update jobs set updated_at = '2099-01-01' where dedupe_key = ?", [keys[7]]);
      await settlePlayerSkillContinuations(db, queue, 40, 7, { userId: 99 }, progress, "2026-01-02T00:00:00.000Z");
      const rows = (await exec(db, "select * from jobs order by id")).rows;
      expect(rows.slice(0, 3).map(r => r.status)).toEqual(["done", "done", "done"]);
      expect(rows.slice(3, 8).map(r => r.status)).toEqual(["queued", "queued", "queued", "running", "queued"]);
      expect(rows[6].locked_by).toBe("worker");
      expect(rows).toHaveLength(9);
      expect(rows[8].status).toBe("queued");
      expect(JSON.parse(String(rows[8].payload_json))).toEqual({ userId: 99, rateVibroPending: 3, calibrationPending: 40, lnMigrationProgress: "100:120" });
    });
  });

  it("leaves old jobs recoverable when replacement enqueue fails", async () => {
    await withDb(async (db, queue) => {
      await queue.enqueue("compute_player_skills", "player-skills:40:99:wife:100", { userId: 99 });
      vi.spyOn(queue, "enqueue").mockRejectedValueOnce(new Error("write unavailable"));
      await expect(settlePlayerSkillContinuations(db, queue, 40, 7, { userId: 99 }, progress, "2099-01-01"))
        .rejects.toThrow("write unavailable");
      expect((await exec(db, "select status from jobs")).rows[0].status).toBe("queued");
    });
  });

  it("retires completed siblings and stops unchanged progress without losing a newly enqueued same-key continuation", async () => {
    await withDb(async (db, queue) => {
      await queue.enqueue("compute_player_skills", "player-skills:40:99:wife:100", { userId: 99 });
      // Future cutoff deliberately covers enqueue time too: explicit key
      // exclusion, not clock resolution, protects the replacement.
      await settlePlayerSkillContinuations(db, queue, 40, 7, { userId: 99 }, progress, "2099-01-01");
      expect((await exec(db, "select count(*) n from jobs where status = 'queued'")).rows[0].n).toBe(1);
      await settlePlayerSkillContinuations(db, queue, 40, 7, { userId: 99, ...progress }, progress, "2099-01-01");
      expect((await exec(db, "select count(*) n from jobs where status = 'queued'")).rows[0].n).toBe(0);
      await queue.enqueue("compute_player_skills", "player-skills:40:99:ln:10:20", { userId: 99 });
      await settlePlayerSkillContinuations(db, queue, 40, 7, { userId: 99 }, done, "2099-01-01");
      expect((await exec(db, "select count(*) n from jobs where status = 'queued'")).rows[0].n).toBe(0);
    });
  });

  it("serializes one player's inputs, releases after failure, and lets other players run", async () => {
    await withDb(async (db) => {
      const events: string[] = [];
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const first = withPlayerSkillTurn(db, 99, async () => { events.push("first"); await gate; throw new Error("failed"); });
      const failed = expect(first).rejects.toThrow("failed");
      const second = withPlayerSkillTurn(db, 99, async () => { events.push("second"); });
      await withPlayerSkillTurn(db, 100, async () => { events.push("other"); });
      expect(events).toEqual(["first", "other"]);
      release();
      await Promise.all([failed, second]);
      expect(events).toEqual(["first", "other", "second"]);
    });
  });
});
