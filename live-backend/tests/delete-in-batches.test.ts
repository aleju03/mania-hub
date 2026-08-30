import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, deleteInBatches, exec, migrate, type Db } from "../src/db.js";

let dir = "";
let db: Db;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mania-delete-in-batches-"));
  db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
  await migrate(db);
});

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

async function seedChannelContexts(count: number, updatedAt: string): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await exec(
      db,
      "insert into discord_channel_map_context (channel_id, beatmap_id, updated_at) values (?, ?, ?)",
      [`${updatedAt}-${i}`, i, updatedAt],
    );
  }
}

describe("deleteInBatches", () => {
  it("keeps the high-volume hourly retention predicates on range indexes", async () => {
    const scorePlan = (await exec(
      db,
      "explain query plan select rowid from score_events where received_at < ? limit 5000",
      ["2025-01-01T00:00:00.000Z"],
    )).rows.map((row) => String(row.detail)).join("\n");
    const doneJobPlan = (await exec(
      db,
      "explain query plan select rowid from jobs where status = 'done' and updated_at < ? limit 5000",
      ["2025-01-01T00:00:00.000Z"],
    )).rows.map((row) => String(row.detail)).join("\n");

    expect(scorePlan).toContain("idx_score_events_received_at");
    expect(doneJobPlan).toContain("idx_jobs_status_updated_at");
  });

  it("deletes across multiple batches and reports the full count", async () => {
    await seedChannelContexts(12, "2020-01-01T00:00:00.000Z");
    await seedChannelContexts(3, "2030-01-01T00:00:00.000Z");

    const deleted = await deleteInBatches(
      db,
      "discord_channel_map_context",
      "updated_at < ?",
      ["2025-01-01T00:00:00.000Z"],
      { batchRows: 5 },
    );

    expect(deleted).toBe(12);
    const remaining = (await exec(db, "select count(*) as n from discord_channel_map_context")).rows;
    expect(Number(remaining[0]?.n)).toBe(3);
  });

  it("stops after one statement when nothing matches", async () => {
    await seedChannelContexts(4, "2030-01-01T00:00:00.000Z");
    const deleted = await deleteInBatches(
      db,
      "discord_channel_map_context",
      "updated_at < ?",
      ["2025-01-01T00:00:00.000Z"],
      { batchRows: 5 },
    );
    expect(deleted).toBe(0);
    const remaining = (await exec(db, "select count(*) as n from discord_channel_map_context")).rows;
    expect(Number(remaining[0]?.n)).toBe(4);
  });

  it("terminates when the match count is an exact multiple of the batch size", async () => {
    await seedChannelContexts(10, "2020-01-01T00:00:00.000Z");
    const deleted = await deleteInBatches(
      db,
      "discord_channel_map_context",
      "updated_at < ?",
      ["2025-01-01T00:00:00.000Z"],
      { batchRows: 5 },
    );
    expect(deleted).toBe(10);
    const remaining = (await exec(db, "select count(*) as n from discord_channel_map_context")).rows;
    expect(Number(remaining[0]?.n)).toBe(0);
  });
});
