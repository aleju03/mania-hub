// @vitest-environment node
/* The key the capture proxy hands the analytics store so a client that keeps
   no storage between page loads is still recognised as one visitor. Its whole
   value depends on two properties: same client today -> same key, and no way
   back to the address it was built from (nor across a day boundary). */
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyServerViewer, buildClientKey } from "./api/sync";

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

  it("prefers the edge address over the forwarded chain", async () => {
    const edge = await buildClientKey(
      request({ "cf-connecting-ip": "203.0.113.7", "x-forwarded-for": "10.0.0.1", "user-agent": CHROME }),
      SECRET,
    );
    const same = await buildClientKey(
      request({ "cf-connecting-ip": "203.0.113.7", "x-forwarded-for": "10.0.0.2", "user-agent": CHROME }),
      SECRET,
    );
    // A caller varying x-forwarded-for cannot mint fresh keys behind the edge.
    expect(edge).toBe(same);
  });
});

/* The acting identity has to come off the session cookie: the store writes it
   into a viewer roster that outlives event pruning, so a browser-supplied one
   would let anyone put words in another player's mouth. */
describe("analytics viewer identity", () => {
  const viewer = { id: 2927048, username: "someone", avatarUrl: "", countryCode: "CR" };

  it("replaces a client-supplied viewer with the signed-in one", () => {
    const [event] = applyServerViewer(
      [{ event: "$pageview", properties: { viewer_id: 1, viewer_username: "not-them", $pathname: "/packs" } }],
      viewer,
    ) as Array<{ properties: Record<string, unknown> }>;
    expect(event.properties).toEqual({ $pathname: "/packs", viewer_id: 2927048, viewer_username: "someone" });
  });

  it("drops a client-supplied viewer entirely when nobody is signed in", () => {
    const [event] = applyServerViewer(
      [{ event: "$pageview", properties: { viewer_id: 1, viewer_username: "not-them" } }],
      null,
    ) as Array<{ properties: Record<string, unknown> }>;
    expect(event.properties).toEqual({});
  });

  it("leaves non-object events and missing property bags alone", () => {
    expect(applyServerViewer(["nope", null], viewer)).toEqual(["nope", null]);
    const [event] = applyServerViewer([{ event: "$pageview" }], null) as Array<Record<string, unknown>>;
    expect(event).toEqual({ event: "$pageview", properties: {} });
  });
});
