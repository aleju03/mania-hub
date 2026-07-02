import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDb, exec, json, migrate } from "../src/db.js";
import { INTERACTIVE_PAUSE_CAP_MS } from "../src/osu/client.js";
import { SqliteSharedRateLimiter } from "../src/osu/shared-rate-limiter.js";

const dirs: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  dirs.length = 0;
});

async function setupLimiters(options: { targetPerMinute: number; hardPerMinute: number }) {
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

  it("lets interactive calls bypass shared target spacing while respecting the hard cap", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T00:00:00.000Z"));
    const { first, second } = await setupLimiters({ targetPerMinute: 1, hardPerMinute: 60 });
    const startedAt = Date.now();

    await first.reserve("job:first", "/first", "job");
    const interactiveStart = await second.reserve("getUser", "/users/1/mania", "interactive");

    expect(interactiveStart).toBe(startedAt);
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
      "insert into live_meta (key, value_json, updated_at) values (?, ?, ?)",
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
});
