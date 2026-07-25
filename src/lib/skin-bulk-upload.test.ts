import { describe, expect, it, vi } from "vitest";

import { rateLimitWaitMs, RequestPacer, withRateLimitRetry } from "./skin-bulk-upload";
import { SkinUploadError } from "./skins";

// A bulk run of forty skins is hundreds of upload requests against a per-IP
// window, so being 429'd is expected rather than exceptional. What matters is
// that a limited request waits exactly as long as the backend asked and then
// carries on, instead of failing the row.

const limited = (retryAfterMs: number | null) =>
  new SkinUploadError("rate_limited", "Too many upload requests.", 429, null, retryAfterMs);

const never = () => false;

describe("rateLimitWaitMs", () => {
  it("takes the backend's own retry window", () => {
    expect(rateLimitWaitMs(limited(4_500))).toBe(4_500);
  });

  it("clamps a missing, tiny, or absurd window", () => {
    expect(rateLimitWaitMs(limited(null))).toBe(20_000);
    expect(rateLimitWaitMs(limited(10))).toBe(1_000);
    expect(rateLimitWaitMs(limited(10 * 60_000))).toBe(60_000);
  });
});

describe("withRateLimitRetry", () => {
  it("passes a successful call straight through", async () => {
    const run = vi.fn(async () => "ok");
    const sleep = vi.fn(async () => {});

    expect(await withRateLimitRetry(run, { onWait: () => {}, cancelled: never, sleep })).toBe("ok");
    expect(run).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("waits the stated window and retries until it lands", async () => {
    const run = vi.fn()
      .mockRejectedValueOnce(limited(3_000))
      .mockRejectedValueOnce(limited(7_000))
      .mockResolvedValue("published");
    const waits: number[] = [];
    const slept: number[] = [];

    const result = await withRateLimitRetry(run, {
      onWait: (ms) => waits.push(ms),
      cancelled: never,
      sleep: async (ms) => { slept.push(ms); },
    });

    expect(result).toBe("published");
    expect(run).toHaveBeenCalledTimes(3);
    expect(slept).toEqual([3_000, 7_000]);
    // The row says what it is waiting for rather than looking stuck.
    expect(waits).toEqual([3_000, 7_000]);
  });

  it("gives up after enough refusals instead of looping forever", async () => {
    const run = vi.fn().mockRejectedValue(limited(1_000));

    await expect(withRateLimitRetry(run, { onWait: () => {}, cancelled: never, sleep: async () => {} }))
      .rejects.toThrow(SkinUploadError);
    expect(run.mock.calls.length).toBeGreaterThan(1);
    expect(run.mock.calls.length).toBeLessThan(20);
  });

  it("rethrows anything that is not a rate limit, without waiting", async () => {
    const run = vi.fn().mockRejectedValue(new SkinUploadError("invalid_osk", "Not a skin.", 400));
    const sleep = vi.fn(async () => {});

    await expect(withRateLimitRetry(run, { onWait: () => {}, cancelled: never, sleep })).rejects.toThrow("Not a skin.");
    expect(run).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("stops when the run is cancelled during the wait", async () => {
    let cancelled = false;
    const run = vi.fn().mockRejectedValue(limited(1_000));

    await expect(withRateLimitRetry(run, {
      onWait: () => {},
      cancelled: () => cancelled,
      // Stopping mid-wait is the common case: the window is seconds long.
      sleep: async () => { cancelled = true; },
    })).rejects.toThrow(SkinUploadError);
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe("RequestPacer", () => {
  // A fake clock: the pacer only reads time, so the window can be walked
  // forward without waiting for it.
  function pacerAt(budget: number) {
    let now = 1_000_000;
    const pacer = new RequestPacer(budget, () => now);
    return { pacer, advance: (ms: number) => { now += ms; } };
  }

  it("lets the budget through back to back", () => {
    const { pacer } = pacerAt(3);
    for (let index = 0; index < 3; index += 1) {
      expect(pacer.waitMs()).toBe(0);
      pacer.record();
    }
    expect(pacer.waitMs()).toBeGreaterThan(0);
  });

  it("waits only until the oldest request ages out of the window", () => {
    const { pacer, advance } = pacerAt(2);
    pacer.record();
    advance(10_000);
    pacer.record();

    // The first request is 10s old, so the window frees up 50s from now.
    expect(pacer.waitMs()).toBeGreaterThan(50_000);
    expect(pacer.waitMs()).toBeLessThan(51_000);

    advance(51_000);
    expect(pacer.waitMs()).toBe(0);
  });

  it("keeps a steady run under the budget", async () => {
    const { pacer, advance } = pacerAt(4);
    const waits: number[] = [];
    // Requests are instant here, so every slot is spent at the same instant
    // and the fifth has to wait out the whole window.
    for (let index = 0; index < 5; index += 1) {
      await pacer.take((ms) => waits.push(ms), async (ms) => { advance(ms); });
    }
    expect(waits).toHaveLength(1);
    expect(waits[0]).toBeGreaterThan(60_000);
  });
});
