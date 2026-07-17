import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, exec, migrate, type Db } from "../src/db.js";
import {
  getOsuJsonWithProxyCache,
  normalizeOsuProxyCacheHints,
  pruneOsuProxyCache,
} from "../src/features/osu-proxy-cache.js";
import type { OsuApiClient } from "../src/osu/client.js";

let dir = "";
let db: Db;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mania-osu-proxy-cache-"));
  db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
  await migrate(db);
});

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

function fakeOsu(handler: (path: string) => Promise<unknown>): { osu: OsuApiClient; calls: string[] } {
  const calls: string[] = [];
  const osu = {
    getJson: async (path: string) => {
      calls.push(path);
      return handler(path);
    },
  } as unknown as OsuApiClient;
  return { osu, calls };
}

const HINTS = { cacheTtlMs: 60_000, staleMs: 60_000 };

describe("normalizeOsuProxyCacheHints", () => {
  it("requires a positive ttl and clamps values", () => {
    expect(normalizeOsuProxyCacheHints({})).toBeNull();
    expect(normalizeOsuProxyCacheHints({ cacheTtlMs: -5 })).toBeNull();
    expect(normalizeOsuProxyCacheHints({ cacheTtlMs: 5000 })).toEqual({ cacheTtlMs: 5000, staleMs: 0 });
    const clamped = normalizeOsuProxyCacheHints({ cacheTtlMs: 999 * 24 * 60 * 60 * 1000, staleMs: 999 * 24 * 60 * 60 * 1000 });
    expect(clamped!.cacheTtlMs).toBe(7 * 24 * 60 * 60 * 1000);
    expect(clamped!.staleMs).toBe(24 * 60 * 60 * 1000);
  });
});

describe("getOsuJsonWithProxyCache", () => {
  it("fetches once, then serves hits without touching the upstream", async () => {
    const { osu, calls } = fakeOsu(async () => ({ username: "aleju" }));

    const first = await getOsuJsonWithProxyCache(db, db, osu, "/users/1", "test", HINTS);
    expect(first).toEqual({ payload: { username: "aleju" }, cache: "miss" });
    const second = await getOsuJsonWithProxyCache(db, db, osu, "/users/1", "test", HINTS);
    expect(second).toEqual({ payload: { username: "aleju" }, cache: "hit" });
    expect(calls).toHaveLength(1);

    // A different path is its own entry.
    await getOsuJsonWithProxyCache(db, db, osu, "/users/2", "test", HINTS);
    expect(calls).toHaveLength(2);
  });

  it("collapses concurrent identical requests onto one upstream call", async () => {
    let resolveUpstream: (value: unknown) => void = () => {};
    const { osu, calls } = fakeOsu(() => new Promise((resolve) => { resolveUpstream = resolve; }));

    const a = getOsuJsonWithProxyCache(db, db, osu, "/users/3", "test", HINTS);
    const b = getOsuJsonWithProxyCache(db, db, osu, "/users/3", "test", HINTS);
    // The upstream is only invoked after the (async) cache read misses; wait for it.
    while (calls.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    resolveUpstream({ id: 3 });
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.payload).toEqual({ id: 3 });
    expect(rb.payload).toEqual({ id: 3 });
    expect(calls).toHaveLength(1);
  });

  it("serves a stale row when the upstream fails inside the stale window", async () => {
    const { osu } = fakeOsu(async () => ({ fresh: true }));
    await getOsuJsonWithProxyCache(db, db, osu, "/users/4", "test", HINTS);
    // Force the row past expiry but inside stale_until.
    await exec(db, "update osu_proxy_cache set expires_at = ?", [Date.now() - 1000]);

    const { osu: failing } = fakeOsu(async () => { throw new Error("osu is down"); });
    const result = await getOsuJsonWithProxyCache(db, db, failing, "/users/4", "test", HINTS);
    expect(result).toEqual({ payload: { fresh: true }, cache: "stale" });
  });

  it("rethrows when the upstream fails with no stale row", async () => {
    const { osu: failing } = fakeOsu(async () => { throw new Error("osu is down"); });
    await expect(getOsuJsonWithProxyCache(db, db, failing, "/users/5", "test", HINTS)).rejects.toThrow("osu is down");
  });

  it("refetches after expiry when no stale window was requested", async () => {
    let counter = 0;
    const { osu, calls } = fakeOsu(async () => ({ n: ++counter }));
    const hints = { cacheTtlMs: 60_000, staleMs: 0 };

    await getOsuJsonWithProxyCache(db, db, osu, "/users/6", "test", hints);
    await exec(db, "update osu_proxy_cache set expires_at = ?, stale_until = ?", [Date.now() - 1000, Date.now() - 1000]);
    const result = await getOsuJsonWithProxyCache(db, db, osu, "/users/6", "test", hints);
    expect(result).toEqual({ payload: { n: 2 }, cache: "miss" });
    expect(calls).toHaveLength(2);
  });
});

describe("pruneOsuProxyCache", () => {
  it("prunes only rows past their stale window", async () => {
    const { osu } = fakeOsu(async () => ({ ok: true }));
    await getOsuJsonWithProxyCache(db, db, osu, "/users/7", "test", HINTS);
    await getOsuJsonWithProxyCache(db, db, osu, "/users/8", "test", HINTS);
    await exec(db, "update osu_proxy_cache set stale_until = ? where path = '/users/7'", [Date.now() - 1000]);

    expect(await pruneOsuProxyCache(db)).toBe(1);
    const remaining = await exec(db, "select path from osu_proxy_cache");
    expect(remaining.rows.map((row) => String(row.path))).toEqual(["/users/8"]);
  });
});
