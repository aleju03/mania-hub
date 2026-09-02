import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InStatement } from "@libsql/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDb, exec, json, migrate } from "../src/db.js";
import { INTERACTIVE_PAUSE_CAP_MS } from "../src/osu/client.js";
import { PRUNE_INTERVAL_MS, SqliteSharedRateLimiter } from "../src/osu/shared-rate-limiter.js";

const dirs: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  dirs.length = 0;
});

async function setupLimiters(options: { targetPerMinute: number; hardPerMinute: number; maxReserveWaitMs?: number; backgroundReservedPerMinute?: number }) {
  const dir = await mkdtemp(join(tmpdir(), "mania-osu-shared-limiter-"));
  dirs.push(dir);
  const databaseUrl = `file:${join(dir, "test.db")}`;
  const dbA = await createDb({ databaseUrl });
  await migrate(dbA);
  const dbB = await createDb({ databaseUrl });
  return {
    db: dbA,
    first: new SqliteSharedRateLimiter(dbA, options),
    second: new SqliteSharedRateLimiter(dbB, options),
  };
}

describe("sqlite shared osu! rate limiter", () => {
  it("shares the hard per-minute cap across connections", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T00:00:00.000Z"));
    const { first, second } = await setupLimiters({ targetPerMinute: 1000, hardPerMinute: 1 });
    const startedAt = Date.now();

    await first.reserve("job:first", "/first", "job");
    let resolved = false;
    const secondStart = second.reserve("job:second", "/second", "job").then(() => {
      resolved = true;
      return Date.now();
    });

    await vi.advanceTimersByTimeAsync(59_999);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(2);

    expect(await secondStart).toBeGreaterThanOrEqual(startedAt + 60_000);
  });

  it("shares target pacing across connections", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T00:00:00.000Z"));
    const { first, second } = await setupLimiters({ targetPerMinute: 60, hardPerMinute: 60 });
    const startedAt = Date.now();

    await first.reserve("job:first", "/first", "job");
    let resolved = false;
    const secondStart = second.reserve("job:second", "/second", "job").then(() => {
      resolved = true;
      return Date.now();
    });

    await vi.advanceTimersByTimeAsync(999);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(2);

    expect(await secondStart).toBeGreaterThanOrEqual(startedAt + 1_000);
  });

  it("gives up reserving after maxReserveWaitMs instead of starving forever", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T00:00:00.000Z"));
    const { first, second } = await setupLimiters({ targetPerMinute: 1, hardPerMinute: 1, maxReserveWaitMs: 30_000 });

    await first.reserve("job:first", "/first", "job");
    // The single per-minute slot is taken for the next 60s, so this reserve
    // can never land within its 30s budget and must reject, not hang.
    const outcome = second.reserve("job:second", "/second", "job").then(
      () => "resolved",
      (error: unknown) => String(error),
    );

    await vi.advanceTimersByTimeAsync(30_001);
    expect(await outcome).toContain("starved");
  });

  it("lets interactive calls bypass shared target spacing while respecting the hard cap", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T00:00:00.000Z"));
    const { first, second } = await setupLimiters({ targetPerMinute: 1, hardPerMinute: 60 });
    const startedAt = Date.now();

    await first.reserve("job:first", "/first", "job");
    const interactiveStart = await second.reserve("getUser", "/users/1/mania", "interactive");

    expect(interactiveStart).toBe(startedAt);
  });

  it("reserves shared hard-window capacity for background lanes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T00:00:00.000Z"));
    const { first, second } = await setupLimiters({
      targetPerMinute: 60_000,
      hardPerMinute: 5,
      backgroundReservedPerMinute: 1,
    });

    for (let index = 0; index < 4; index += 1) {
      await first.reserve(`api:farm-helper:${index}`, `/users/${index}/mania`, "interactive");
    }
    let extraInteractiveResolved = false;
    const extraInteractive = first.reserve("api:farm-helper:extra", "/users/99/mania", "interactive").then(() => {
      extraInteractiveResolved = true;
    });

    let jobResolved = false;
    const job = second.reserve("job:enrich_user", "/users/100/mania", "job").then(() => {
      jobResolved = true;
    });
    await vi.advanceTimersByTimeAsync(2);
    await job;

    expect(jobResolved).toBe(true);
    expect(extraInteractiveResolved).toBe(false);

    await vi.advanceTimersByTimeAsync(60_001);
    await extraInteractive;
  });

  it("caps the shared 429 pause for interactive lanes while jobs wait it out", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T00:00:00.000Z"));
    const { first, second } = await setupLimiters({ targetPerMinute: 1000, hardPerMinute: 1000 });
    await first.pause(60_000);

    let interactiveResolved = false;
    let jobResolved = false;
    const interactive = second.reserve("getUser", "/users/1/mania", "interactive").then(() => {
      interactiveResolved = true;
    });
    const job = second.reserve("job:enrich_user", "/users/2/mania", "job").then(() => {
      jobResolved = true;
    });

    await vi.advanceTimersByTimeAsync(INTERACTIVE_PAUSE_CAP_MS + 5);
    await interactive;
    expect(interactiveResolved).toBe(true);
    expect(jobResolved).toBe(false);

    await vi.advanceTimersByTimeAsync(60_000);
    await job;
    expect(jobResolved).toBe(true);
  });

  it("honours a legacy bare-number pause value", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T00:00:00.000Z"));
    const { db, first } = await setupLimiters({ targetPerMinute: 1000, hardPerMinute: 1000 });
    await exec(
      db,
      "insert into journal_meta (key, value_json, updated_at) values (?, ?, ?)",
      ["control:osu_rate_limit_paused_until", json(Date.now() + 30_000), new Date().toISOString()],
    );

    // Legacy shape assumes the default 60s pause, so a 30s-out deadline reads
    // as 30s into the pause: past the interactive cap, still paused for jobs.
    const interactiveStart = await first.reserve("getUser", "/users/1/mania", "interactive");
    expect(interactiveStart).toBe(Date.now());

    let jobResolved = false;
    const job = first.reserve("job:enrich_user", "/users/2/mania", "job").then(() => {
      jobResolved = true;
    });
    await vi.advanceTimersByTimeAsync(29_000);
    expect(jobResolved).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    await job;
    expect(jobResolved).toBe(true);
  });

  it("serializes concurrent reservations on one local connection", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mania-osu-shared-limiter-"));
    dirs.push(dir);
    const db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
    await migrate(db);
    const limiter = new SqliteSharedRateLimiter(db, { targetPerMinute: 1000, hardPerMinute: 1000 });

    await expect(Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        limiter.reserve(`api:profile_snapshot:${index}`, `/users/${index}/mania`, "interactive"),
      ),
    )).resolves.toHaveLength(20);

    const row = (await exec(db, "select count(*) as count from api_rate_limit_reservations")).rows[0];
    expect(Number(row.count)).toBe(20);
  });

  // The sweep used to run inside every reservation attempt, so a saturated
  // budget (every waiting caller re-attempting on its own wake-up) turned into
  // a storm of write-lock acquisitions on the busiest DB in the system,
  // exactly when it was already contended.
  it("sweeps expired reservations on an interval, not on every attempt", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T00:00:00.000Z"));
    const dir = await mkdtemp(join(tmpdir(), "mania-osu-shared-limiter-"));
    dirs.push(dir);
    const db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
    await migrate(db);
    const limiter = new SqliteSharedRateLimiter(db, { targetPerMinute: 1000, hardPerMinute: 1000 });

    const deletes: string[] = [];
    const execute = db.execute.bind(db);
    db.execute = ((statement: InStatement) => {
      const sql = typeof statement === "string" ? statement : statement.sql;
      if (sql.startsWith("delete from api_rate_limit_reservations")) deletes.push(sql);
      return execute(statement);
    }) as typeof db.execute;

    // First reservation sweeps; the rest of the minute rides on it.
    for (let index = 0; index < 5; index += 1) {
      await limiter.reserve(`api:snapshot:${index}`, `/users/${index}/mania`, "interactive");
      vi.setSystemTime(new Date(Date.now() + 5_000));
    }
    expect(deletes).toHaveLength(1);

    // Past the interval it sweeps again, and the expired rows really do go.
    vi.setSystemTime(new Date(Date.now() + PRUNE_INTERVAL_MS));
    await limiter.reserve("api:snapshot:late", "/users/late/mania", "interactive");
    expect(deletes).toHaveLength(2);

    vi.setSystemTime(new Date(Date.now() + 6 * 60_000));
    await limiter.reserve("api:snapshot:last", "/users/last/mania", "interactive");
    const remaining = (await exec(db, "select count(*) as count from api_rate_limit_reservations")).rows[0];
    expect(Number(remaining.count)).toBe(1);
  });
});
