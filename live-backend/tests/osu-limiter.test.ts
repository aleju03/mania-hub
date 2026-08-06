import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDb, exec, logApiCall, migrate } from "../src/db.js";
import { INTERACTIVE_PAUSE_CAP_MS, OsuApiError, TokenBucketLimiter, type LimiterCallLog } from "../src/osu/client.js";

const dirs: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  dirs.length = 0;
});

describe("token bucket limiter", () => {
  it("caps the 429 pause for interactive calls while jobs wait it out", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T00:00:00.000Z"));
    const limiter = new TokenBucketLimiter(1000, 1000, undefined, { interactiveBurstCapacity: 4 });
    limiter.pause(60_000);

    let interactiveDone = false;
    let jobDone = false;
    const interactive = limiter.schedule("getUser", "/users/1/mania", async () => {
      interactiveDone = true;
    });
    const job = limiter.schedule("job:enrich_user", "/users/2/mania", async () => {
      jobDone = true;
    });

    await vi.advanceTimersByTimeAsync(INTERACTIVE_PAUSE_CAP_MS - 10);
    expect(interactiveDone).toBe(false);
    expect(jobDone).toBe(false);

    await vi.advanceTimersByTimeAsync(20);
    await interactive;
    expect(interactiveDone).toBe(true);
    expect(jobDone).toBe(false);

    await vi.advanceTimersByTimeAsync(60_000);
    await job;
    expect(jobDone).toBe(true);
  });

  it("keeps sustained interactive demand near the target rate", async () => {
    // The burst bucket used to refill at targetPerMinute, so a steady stream of
    // page loads ran at roughly twice the target until the hard ceiling caught
    // it - which is how the budget sat pinned at 120/120 for six minutes on
    // 2026-08-06. It may still absorb a spike; it may not sustain one.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T00:00:00.000Z"));
    const target = 60;
    const burst = 4;
    const limiter = new TokenBucketLimiter(1000, target, undefined, { interactiveBurstCapacity: burst });

    let done = 0;
    for (let call = 0; call < 300; call += 1) {
      void limiter.schedule("api:profile_snapshot", `/users/${call}/mania`, async () => {
        done += 1;
      });
    }

    // The bucket starts full, so the first few go out immediately.
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBeGreaterThanOrEqual(burst);
    expect(done).toBeLessThanOrEqual(burst + 1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(done).toBeGreaterThan(target * 0.9);
    expect(done).toBeLessThanOrEqual(target + 2 * burst + 2);
  });

  it("reports duration and status through onCall", async () => {
    const calls: LimiterCallLog[] = [];
    const limiter = new TokenBucketLimiter(1000, 1000, (entry) => calls.push(entry));

    await limiter.schedule("getUser", "/users/1/mania", async () => "ok");
    expect(calls).toHaveLength(1);
    expect(calls[0].status).toBe(200);
    expect(calls[0].durationMs).toBeGreaterThanOrEqual(0);

    await expect(limiter.schedule("getReplayParsed:legacy", "/scores/mania/1/download", async () => {
      throw new OsuApiError(404, "/scores/mania/1/download");
    })).rejects.toThrow("404");
    expect(calls).toHaveLength(2);
    expect(calls[1].status).toBe(404);

    await expect(limiter.schedule("getUser", "/users/2/mania", async () => {
      throw new Error("socket hang up");
    })).rejects.toThrow("socket hang up");
    expect(calls).toHaveLength(3);
    expect(calls[2].status).toBe(null);
  });
});

describe("api call log durations", () => {
  it("persists duration and status columns", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mania-api-call-log-"));
    dirs.push(dir);
    const db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
    await migrate(db);

    await logApiCall(db, {
      provider: "osu",
      caller: "getReplayParsed:modern",
      path: "/scores/1/download",
      startedAt: new Date("2026-06-01T00:00:00.000Z").toISOString(),
      durationMs: 1234,
      status: 200,
    });
    await logApiCall(db, {
      provider: "osu",
      caller: "job:enrich_user",
      path: "/users/1/mania",
      startedAt: new Date("2026-06-01T00:00:01.000Z").toISOString(),
    });

    const rows = (await exec(db, "select duration_ms, status from api_call_log order by id asc")).rows;
    expect(Number(rows[0].duration_ms)).toBe(1234);
    expect(Number(rows[0].status)).toBe(200);
    expect(rows[1].duration_ms).toBe(null);
    expect(rows[1].status).toBe(null);
  });
});
