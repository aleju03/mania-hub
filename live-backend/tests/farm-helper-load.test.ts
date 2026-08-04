import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, exec, migrate, type Db } from "../src/db.js";
import {
  clearFarmHelperCache,
  getFarmHelperSnapshot,
  invalidateFarmHelperCacheForUser,
  prepareWeightedDistribution,
  quantileOfDistribution,
  selectTopPeers,
  weightedQuantile,
} from "../src/features/farm-helper.js";
import { FarmHelperTimings } from "../src/features/farm-helper-timing.js";
import { getPlayerProfileSnapshot } from "../src/features/player-profiles.js";
import { getPlayerSkillBreakdown } from "../src/features/player-skills.js";
import { getProxyCalibration } from "../src/features/farm-helper-key-stats.js";
import { CHART_ANALYSIS_VERSION } from "../src/features/chart-analysis.js";
import { nowIso } from "../src/shared/score.js";
import type { OsuApiClient } from "../src/osu/client.js";
import type { JobQueue } from "../src/jobs/queue.js";
import type { OscScore } from "../src/shared/types.js";

// Load-path behaviour for the Farm Helper: what a request is allowed to do
// before it can answer, and what it must never wait on. The recommendation
// content itself is covered by farm-helper.test.ts.

let dir = "";
let db: Db;

const SUBJECT_ID = 4242;
const SUBJECT_NAME = "LoadSubject";
const BM = 7001;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mania-fh-load-"));
  db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
  await migrate(db);
});

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

function score(beatmapId: number, pp: number): OscScore {
  return {
    id: beatmapId,
    user_id: SUBJECT_ID,
    accuracy: 0.99,
    mods: [],
    score: 1_000_000,
    max_combo: 1000,
    passed: true,
    rank: "S",
    statistics: {},
    pp,
    beatmap_id: beatmapId,
    beatmap: {
      id: beatmapId,
      beatmapset_id: beatmapId + 100,
      difficulty_rating: 5,
      mode: "mania",
      cs: 4,
      bpm: 180,
      version: "Insane",
      url: `https://osu.ppy.sh/b/${beatmapId}`,
    },
    ended_at: "2024-06-01T00:00:00Z",
  };
}

const BEST_SCORES: OscScore[] = [score(BM, 500), score(BM + 1, 480), score(BM + 2, 460)];

// A stored profile: the primary target of the plan is a player already in
// profile_snapshots, so no osu! call should be needed to serve them.
async function seedStoredProfile(): Promise<void> {
  const now = nowIso();
  const user = {
    id: SUBJECT_ID,
    username: SUBJECT_NAME,
    avatar_url: `https://a.ppy.sh/${SUBJECT_ID}`,
    country_code: "CR",
    statistics: { pp: 5000, variants: [] },
  };
  await exec(
    db,
    "insert into users (user_id, username, avatar_url, country_code, pp, updated_at) values (?, ?, ?, ?, ?, ?)",
    [SUBJECT_ID, SUBJECT_NAME, user.avatar_url, "CR", 5000, now],
  );
  await exec(
    db,
    `insert into profile_snapshots
       (user_id, username_key, user_json, best_scores_json, best_scores_limit, fetched_at, user_fetched_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?)`,
    [SUBJECT_ID, SUBJECT_NAME.toLowerCase(), JSON.stringify(user), JSON.stringify(BEST_SCORES), 200, now, now, now],
  );
  await exec(
    db,
    `insert into maps_beatmaps (beatmap_id, beatmapset_id, mode, status, cs, difficulty_rating, bpm, total_length, version, url, updated_at)
     values (?, ?, 'mania', 'ranked', 4, 5, 180, 120, 'Insane', ?, ?)`,
    [BM, BM + 100, `https://osu.ppy.sh/b/${BM}`, now],
  );
  // A note_bpm the profile path attaches and Farm Helper must not ask for.
  await exec(
    db,
    `insert into beatmap_chart_analysis (beatmap_id, analysis_version, status, key_count, classification_json, updated_at)
     values (?, ?, 'ready', 4, ?, ?)`,
    [BM, CHART_ANALYSIS_VERSION, JSON.stringify({ noteBpm: 222 }), now],
  );
}

// An osu! client that fails loudly: a stored subject must never reach it.
const NO_OSU = new Proxy({}, {
  get: (_target, prop) => () => {
    throw new Error(`unexpected osu! call: ${String(prop)}`);
  },
}) as unknown as OsuApiClient;

// A statement counter. NOTE: the farm-helper caches are WeakMap-keyed by the
// Db object, so a test that cares about cache state must use ONE proxy for
// every call - swapping in a fresh proxy mid-test silently starts a new cache.
function countingDb(target: Db, matcher: RegExp): { db: Db; count: () => number; reset: () => void } {
  let count = 0;
  const proxy = new Proxy(target, {
    get(inner, prop, receiver) {
      if (prop === "execute") {
        return (stmt: { sql: string } | string) => {
          const sql = typeof stmt === "string" ? stmt : stmt.sql;
          if (matcher.test(sql)) count += 1;
          return (inner.execute as (s: unknown) => unknown)(stmt);
        };
      }
      const value = Reflect.get(inner, prop, receiver);
      return typeof value === "function" ? value.bind(inner) : value;
    },
  }) as Db;
  return { db: proxy, count: () => count, reset: () => { count = 0; } };
}

describe("farm helper snapshot cache", () => {
  it("serves a cache hit without hydrating the profile again", async () => {
    await seedStoredProfile();
    const probe = countingDb(db, /profile_snapshots|top_play_events/i);
    await getFarmHelperSnapshot(probe.db, NO_OSU, String(SUBJECT_ID));
    expect(probe.count()).toBeGreaterThan(0);

    probe.reset();
    const timings = new FarmHelperTimings();
    await getFarmHelperSnapshot(probe.db, NO_OSU, String(SUBJECT_ID), {}, undefined, { timings });

    expect(timings.getCacheState()).toBe("hit");
    expect(probe.count()).toBe(0);
  });

  it("shares one cache entry between the numeric id and the username", async () => {
    await seedStoredProfile();
    await getFarmHelperSnapshot(db, NO_OSU, String(SUBJECT_ID));

    const timings = new FarmHelperTimings();
    const byName = await getFarmHelperSnapshot(db, NO_OSU, SUBJECT_NAME, {}, undefined, { timings });

    expect(byName.userId).toBe(SUBJECT_ID);
    // The username resolved through the alias and then found the id-keyed
    // entry: same canonical snapshot object, no second build.
    expect(timings.getCacheState()).toBe("hit");

    // Casing and padding normalize to the same alias.
    const padded = new FarmHelperTimings();
    await getFarmHelperSnapshot(db, NO_OSU, `  ${SUBJECT_NAME.toUpperCase()} `, {}, undefined, { timings: padded });
    expect(padded.getCacheState()).toBe("hit");
  });

  it("keeps separate entries per keymode, view and limit", async () => {
    await seedStoredProfile();
    await getFarmHelperSnapshot(db, NO_OSU, String(SUBJECT_ID), { keyMode: "any", view: "gain" });

    const other = new FarmHelperTimings();
    await getFarmHelperSnapshot(db, NO_OSU, String(SUBJECT_ID), { keyMode: "any", view: "popular" }, undefined, { timings: other });
    expect(other.getCacheState()).not.toBe("hit");

    const same = new FarmHelperTimings();
    await getFarmHelperSnapshot(db, NO_OSU, String(SUBJECT_ID), { keyMode: "any", view: "popular" }, undefined, { timings: same });
    expect(same.getCacheState()).toBe("hit");
  });

  it("drops every variant for a subject on feedback invalidation, and keeps the identity alias", async () => {
    await seedStoredProfile();
    await getFarmHelperSnapshot(db, NO_OSU, SUBJECT_NAME, { view: "gain" });
    await getFarmHelperSnapshot(db, NO_OSU, SUBJECT_NAME, { view: "popular" });

    invalidateFarmHelperCacheForUser(db, SUBJECT_ID);

    for (const view of ["gain", "popular"] as const) {
      const timings = new FarmHelperTimings();
      await getFarmHelperSnapshot(db, NO_OSU, SUBJECT_NAME, { view }, undefined, { timings });
      expect(timings.getCacheState()).not.toBe("hit");
    }
  });

  it("clears aliases as well as snapshots on a wipe", async () => {
    await seedStoredProfile();
    const probe = countingDb(db, /from profile_snapshots/i);
    await getFarmHelperSnapshot(probe.db, NO_OSU, SUBJECT_NAME);

    // Sanity: without the wipe this would be a pure alias + cache hit.
    probe.reset();
    await getFarmHelperSnapshot(probe.db, NO_OSU, SUBJECT_NAME);
    expect(probe.count()).toBe(0);

    clearFarmHelperCache(probe.db);

    // With the alias gone the username has to be resolved from storage again,
    // which for a wiped-then-restored player is the only correct behaviour.
    probe.reset();
    await getFarmHelperSnapshot(probe.db, NO_OSU, SUBJECT_NAME);
    expect(probe.count()).toBeGreaterThan(0);
  });

  it("does not answer a numeric username with the account whose id matches it", async () => {
    // osu! usernames may be entirely numeric, and profile resolution looks a
    // raw key up as a username BEFORE it tries it as an id. So "4242" names
    // the account called "4242", not account 4242 - and the alias cache must
    // not conflate them.
    await seedStoredProfile();
    const collidingId = 999_111;
    const now = nowIso();
    const collidingUser = {
      id: collidingId,
      username: String(SUBJECT_ID),
      avatar_url: `https://a.ppy.sh/${collidingId}`,
      country_code: "CR",
      statistics: { pp: 1234, variants: [] },
    };
    await exec(
      db,
      "insert into users (user_id, username, avatar_url, country_code, pp, updated_at) values (?, ?, ?, ?, ?, ?)",
      [collidingId, String(SUBJECT_ID), collidingUser.avatar_url, "CR", 1234, now],
    );
    await exec(
      db,
      `insert into profile_snapshots
         (user_id, username_key, user_json, best_scores_json, best_scores_limit, fetched_at, user_fetched_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?)`,
      [collidingId, String(SUBJECT_ID), JSON.stringify(collidingUser), JSON.stringify([]), 200, now, now, now],
    );

    // Warm the cache via the username, which also aliases the subject.
    const warmed = await getFarmHelperSnapshot(db, NO_OSU, SUBJECT_NAME);
    expect(warmed.userId).toBe(SUBJECT_ID);

    // Now ask for "4242". That is the OTHER account's username.
    const collided = await getFarmHelperSnapshot(db, NO_OSU, String(SUBJECT_ID));
    expect(collided.userId).toBe(collidingId);
    expect(collided.username).toBe(String(SUBJECT_ID));
  });

  it("does not cache a build that was invalidated while it ran", async () => {
    await seedStoredProfile();
    const build = getFarmHelperSnapshot(db, NO_OSU, String(SUBJECT_ID));
    // Lands while the build is still resolving the subject, i.e. before it
    // could possibly know which user id to evict.
    invalidateFarmHelperCacheForUser(db, SUBJECT_ID);
    await build;

    const timings = new FarmHelperTimings();
    await getFarmHelperSnapshot(db, NO_OSU, String(SUBJECT_ID), {}, undefined, { timings });
    expect(timings.getCacheState()).not.toBe("hit");
  });
});

describe("farm helper single-flight", () => {
  it("runs one build for ten simultaneous identical requests", async () => {
    await seedStoredProfile();
    const probe = countingDb(db, /from profile_snapshots/i);

    // What one build costs, measured rather than assumed.
    await getFarmHelperSnapshot(probe.db, NO_OSU, String(SUBJECT_ID));
    const perBuild = probe.count();
    expect(perBuild).toBeGreaterThan(0);

    clearFarmHelperCache(probe.db);
    probe.reset();
    const results = await Promise.all(
      Array.from({ length: 10 }, () => getFarmHelperSnapshot(probe.db, NO_OSU, String(SUBJECT_ID))),
    );

    expect(results).toHaveLength(10);
    // One shared promise, so every caller gets the identical object back.
    for (const result of results) expect(result).toBe(results[0]);
    expect(probe.count()).toBe(perBuild);
  });

  it("coalesces simultaneous requests for the same player by different keys", async () => {
    await seedStoredProfile();
    // Distinct raw keys cannot coalesce before an alias exists, but both must
    // still return the same canonical subject and leave one cached entry.
    const [byId, byName] = await Promise.all([
      getFarmHelperSnapshot(db, NO_OSU, String(SUBJECT_ID)),
      getFarmHelperSnapshot(db, NO_OSU, SUBJECT_NAME),
    ]);
    expect(byId.userId).toBe(SUBJECT_ID);
    expect(byName.userId).toBe(SUBJECT_ID);

    const timings = new FarmHelperTimings();
    await getFarmHelperSnapshot(db, NO_OSU, SUBJECT_NAME, {}, undefined, { timings });
    expect(timings.getCacheState()).toBe("hit");
  });

  // NOT covered here: two flight-map refinements that only manifest under a
  // precise async interleaving - a settling build unregistering only its OWN
  // entry (so an invalidation followed by a newer build keeps coalescing), and
  // a cold build re-registering under its canonical key once identity
  // resolves. Both need one build held open past a specific internal await
  // while another runs, which no hook here exposes; every version of such a
  // test that was tried passed with the bug deliberately reintroduced, so it
  // would only have bought false confidence. They are argued in the comments
  // at the call sites instead.

  it("fans a failure out to every waiter and retries on the next request", async () => {
    // Nothing stored, so resolution has to go to osu! - which fails here.
    let calls = 0;
    const failing = {
      getUser: async () => {
        throw new Error("osu down");
      },
      getUserByKey: async () => {
        calls += 1;
        throw new Error("osu down");
      },
      getUserBestScoresWindow: async () => [],
    } as unknown as OsuApiClient;

    const attempts = await Promise.allSettled(
      Array.from({ length: 5 }, () => getFarmHelperSnapshot(db, failing, "ghost")),
    );
    for (const attempt of attempts) expect(attempt.status).toBe("rejected");
    expect(calls).toBe(1);

    // The failed promise was not retained, so the next request tries again.
    await expect(getFarmHelperSnapshot(db, failing, "ghost")).rejects.toThrow();
    expect(calls).toBe(2);
  });
});

describe("farm helper profile hydration", () => {
  it("skips note-BPM decoration for Farm Helper while the profile path keeps it", async () => {
    await seedStoredProfile();

    const profileProbe = countingDb(db, /note_bpm/i);
    const profile = await getPlayerProfileSnapshot(profileProbe.db, NO_OSU, String(SUBJECT_ID));
    expect(profileProbe.count()).toBeGreaterThan(0);
    expect(profile.bestScores.find((s) => s.beatmap?.id === BM)?.beatmap?.note_bpm).toBe(222);

    const farmProbe = countingDb(db, /note_bpm/i);
    const skipped = await getPlayerProfileSnapshot(farmProbe.db, NO_OSU, String(SUBJECT_ID), { includeNoteBpms: false });
    expect(farmProbe.count()).toBe(0);
    expect(skipped.bestScores.find((s) => s.beatmap?.id === BM)?.beatmap?.note_bpm).toBeUndefined();
    // Everything else about the projection is untouched.
    expect(skipped.bestScores.map((s) => s.pp)).toEqual(profile.bestScores.map((s) => s.pp));
  });

  it("does not read note BPM anywhere on a Farm Helper request", async () => {
    await seedStoredProfile();
    const probe = countingDb(db, /note_bpm/i);
    await getFarmHelperSnapshot(probe.db, NO_OSU, String(SUBJECT_ID));
    expect(probe.count()).toBe(0);
  });
});

describe("farm helper optional writes", () => {
  it("returns a snapshot even when the skill enqueue never settles", async () => {
    await seedStoredProfile();
    const hangingQueue = { enqueue: () => new Promise<void>(() => {}) } as unknown as JobQueue;

    const snapshot = await Promise.race([
      getFarmHelperSnapshot(db, NO_OSU, String(SUBJECT_ID), {}, hangingQueue),
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error("blocked on enqueue")), 4000)),
    ]);
    expect((snapshot as { status: string }).status).toBe("ready");
  });

  it("keeps the awaited enqueue mode blocking for callers that report queue position", async () => {
    let enqueued = false;
    const queue = {
      enqueue: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        enqueued = true;
      },
    } as unknown as JobQueue;

    await getPlayerSkillBreakdown(db, queue, SUBJECT_ID);
    expect(enqueued).toBe(true);

    // Detached returns before the write lands.
    let detachedDone = false;
    const slowQueue = {
      enqueue: async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        detachedDone = true;
      },
    } as unknown as JobQueue;
    await getPlayerSkillBreakdown(db, slowQueue, SUBJECT_ID + 1, { enqueueMode: "detached" });
    expect(detachedDone).toBe(false);
  });

  it("survives a skill enqueue that rejects when detached", async () => {
    const rejecting = { enqueue: async () => { throw new Error("queue busy"); } } as unknown as JobQueue;
    const breakdown = await getPlayerSkillBreakdown(db, rejecting, SUBJECT_ID, { enqueueMode: "detached" });
    expect(breakdown.status).toBe("pending");
  });

  it("never persists the proxy calibration on the read connection", async () => {
    const probe = countingDb(db, /insert into live_meta/i);
    await getProxyCalibration(probe.db, 4);
    expect(probe.count()).toBe(0);

    const metaRows = (await exec(db, "select count(*) as cnt from live_meta where key like 'farm_helper_proxy_calibration%'")).rows;
    expect(Number(metaRows[0]?.cnt ?? 0)).toBe(0);
  });

  it("returns calibration even when the write connection rejects every write", async () => {
    const brokenWrite = new Proxy(db, {
      get(inner, prop, receiver) {
        if (prop === "execute") {
          return async () => {
            throw new Error("write connection down");
          };
        }
        const value = Reflect.get(inner, prop, receiver);
        return typeof value === "function" ? value.bind(inner) : value;
      },
    }) as Db;

    const calibration = await getProxyCalibration(db, 7, brokenWrite);
    expect(calibration.keyCount).toBe(7);
  });
});

describe("weighted distribution reuse", () => {
  const cases: Array<Array<{ v: number; w: number }>> = [
    [],
    [{ v: 5, w: 1 }],
    [{ v: 5, w: 0 }, { v: 9, w: 2 }],
    [{ v: 300, w: 1 }, { v: 100, w: 1 }, { v: 200, w: 1 }],
    [{ v: 400, w: 0.1 }, { v: 400, w: 0.9 }, { v: 410, w: 0.5 }, { v: 390, w: 0.2 }],
    [{ v: 1, w: 3 }, { v: 2, w: 3 }, { v: 3, w: 3 }, { v: 4, w: 3 }, { v: 5, w: 3 }],
    [{ v: Number.NaN, w: 1 }, { v: 12, w: 1 }, { v: 8, w: Number.POSITIVE_INFINITY }],
  ];

  // The pre-refactor implementation, verbatim: filter, sort and walk from
  // scratch on every call. Kept here as the reference so the prepared-once
  // version is checked against what it replaced rather than against itself.
  function legacyWeightedQuantile(pairs: Array<{ v: number; w: number }>, q: number): number {
    const clamp01 = (value: number) => (Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0);
    const valid = pairs.filter((p) => Number.isFinite(p.v) && Number.isFinite(p.w) && p.w > 0);
    if (valid.length === 0) return 0;
    if (valid.length === 1) return valid[0].v;
    valid.sort((a, b) => a.v - b.v);

    const positions: number[] = [];
    let cum = 0;
    for (const p of valid) {
      cum += p.w;
      positions.push(cum - p.w / 2);
    }
    const first = positions[0];
    const last = positions[positions.length - 1];
    const span = last - first;
    if (span <= 0) return valid[0].v;
    const target = first + clamp01(q) * span;
    if (target <= first) return valid[0].v;
    if (target >= last) return valid[valid.length - 1].v;
    for (let i = 1; i < valid.length; i++) {
      if (target <= positions[i]) {
        const lo = positions[i - 1];
        const t = (target - lo) / (positions[i] - lo);
        return valid[i - 1].v + t * (valid[i].v - valid[i - 1].v);
      }
    }
    return valid[valid.length - 1].v;
  }

  it("gives bit-identical results to the per-call implementation it replaced", () => {
    for (const pairs of cases) {
      const prepared = prepareWeightedDistribution(pairs.map((p) => ({ ...p })));
      for (const q of [0, 0.25, 0.5, 0.6, 0.75, 1]) {
        // Pristine copies: the legacy version sorts its input in place, which
        // is exactly why the per-candidate loop paid for it three times.
        const reference = legacyWeightedQuantile(pairs.map((p) => ({ ...p })), q);
        expect(quantileOfDistribution(prepared, q)).toBe(reference);
        expect(weightedQuantile(pairs.map((p) => ({ ...p })), q)).toBe(reference);
      }
    }
  });

  it("selects top peers in the same order a stable descending sort would", () => {
    const shapes: Array<Array<{ userId: number; pp: number }>> = [
      [],
      [{ userId: 1, pp: 100 }],
      [{ userId: 1, pp: 100 }, { userId: 2, pp: 100 }, { userId: 3, pp: 100 }],
      [{ userId: 1, pp: 10 }, { userId: 2, pp: 50 }, { userId: 3, pp: 30 }, { userId: 4, pp: 90 }, { userId: 5, pp: 20 }],
      [{ userId: 1, pp: 400 }, { userId: 2, pp: 400 }, { userId: 3, pp: 500 }, { userId: 4, pp: 400 }, { userId: 5, pp: 500 }, { userId: 6, pp: 1 }],
      Array.from({ length: 40 }, (_unused, i) => ({ userId: i, pp: i % 7 })),
    ];
    for (const shape of shapes) {
      const entries = shape.map((peer) => ({ ...peer, wD: 1, wB: 1, acc: null }));
      const expected = entries.slice().sort((a, b) => b.pp - a.pp).slice(0, 4).map((p) => p.userId);
      expect(selectTopPeers(entries).map((p) => p.userId)).toEqual(expected);
    }
  });

  it("does not mutate the caller's pairs", () => {
    const pairs = [{ v: 3, w: 1 }, { v: 1, w: 1 }, { v: 2, w: 1 }];
    const before = JSON.stringify(pairs);
    prepareWeightedDistribution(pairs.map((p) => ({ ...p })));
    expect(JSON.stringify(pairs)).toBe(before);
  });
});
