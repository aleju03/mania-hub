import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDb, migrate } from "../src/db.js";
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
});
