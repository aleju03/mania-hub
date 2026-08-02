// @vitest-environment node
/* The key the capture proxy hands the analytics store so a client that keeps
   no storage between page loads is still recognised as one visitor. Its whole
   value depends on two properties: same client today -> same key, and no way
   back to the address it was built from (nor across a day boundary). */
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildClientKey } from "./api/sync";

const SECRET = "test-admin-token";

function request(headers: Record<string, string>): Request {
  return new Request("https://mania-tracker.com/api/sync", { method: "POST", headers });
}

const CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0";

afterEach(() => {
  vi.useRealTimers();
});

describe("analytics client key", () => {
  it("is stable for one client and different for another", async () => {
    const first = await buildClientKey(request({ "x-forwarded-for": "203.0.113.7", "user-agent": CHROME }), SECRET);
    const again = await buildClientKey(request({ "x-forwarded-for": "203.0.113.7", "user-agent": CHROME }), SECRET);
    const otherAddress = await buildClientKey(request({ "x-forwarded-for": "198.51.100.4", "user-agent": CHROME }), SECRET);
    const otherAgent = await buildClientKey(request({ "x-forwarded-for": "203.0.113.7", "user-agent": "Firefox/141.0" }), SECRET);

    expect(first).toMatch(/^[0-9a-f]{16}$/);
    expect(again).toBe(first);
    expect(otherAddress).not.toBe(first);
    expect(otherAgent).not.toBe(first);
  });

  // The address is hashed with a secret and the day, so the key cannot be
  // walked back to a person and cannot follow one across days.
  it("reveals nothing about the address and rotates at UTC midnight", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-01T23:59:00.000Z"));
    const beforeMidnight = await buildClientKey(request({ "x-forwarded-for": "203.0.113.7", "user-agent": CHROME }), SECRET);

    vi.setSystemTime(new Date("2026-08-02T00:01:00.000Z"));
    const afterMidnight = await buildClientKey(request({ "x-forwarded-for": "203.0.113.7", "user-agent": CHROME }), SECRET);

    expect(beforeMidnight).not.toBe(afterMidnight);
    expect(beforeMidnight).not.toContain("203.0.113.7");
    // A different secret over the same inputs must not reproduce it either.
    vi.setSystemTime(new Date("2026-08-01T23:59:00.000Z"));
    expect(await buildClientKey(request({ "x-forwarded-for": "203.0.113.7", "user-agent": CHROME }), "other-secret"))
      .not.toBe(beforeMidnight);
  });

  it("takes the client from the front of x-forwarded-for, and gives up without one", async () => {
    const chained = await buildClientKey(
      request({ "x-forwarded-for": "203.0.113.7, 70.41.3.18, 150.172.238.178", "user-agent": CHROME }),
      SECRET,
    );
    const direct = await buildClientKey(request({ "x-forwarded-for": "203.0.113.7", "user-agent": CHROME }), SECRET);
    expect(chained).toBe(direct);

    // No address or no agent: no key, and the store falls back to the client's
    // own id exactly as it did before any of this existed.
    expect(await buildClientKey(request({ "user-agent": CHROME }), SECRET)).toBeNull();
    expect(await buildClientKey(request({ "x-forwarded-for": "203.0.113.7" }), SECRET)).toBeNull();
  });
});
