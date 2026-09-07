import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, exec, migrate, type Db } from "../src/db.js";
import { getSweepReports } from "../src/features/sweeps-status.js";
import { CHART_FAMILY_META_KEY, CHART_FAMILY_SWEEP_JOB } from "../src/features/chart-families.js";
import { PLAYER_SKILL_DAN_SWEEP_META_KEY, PLAYER_SKILL_DAN_SWEEP_JOB } from "../src/features/player-skills.js";
import {
  TOP_SCORES_BACKFILL_DONE_META_KEY,
  TOP_SCORES_BACKFILL_JOB,
  TOP_SCORES_BACKFILL_PROGRESS_META_KEY,
} from "../src/features/top-scores-backfill.js";
import { SKILL_BASELINE_CURVES_META_KEY } from "../src/features/skill-baseline.js";
import { AbuseGuard } from "../src/http/abuse-guard.js";
import { routeHttp } from "../src/http/snapshots.js";
import { JobQueue } from "../src/jobs/queue.js";
import { LiveEventLog } from "../src/live/event-log.js";

let dir = "";
let db: Db;
let queue: JobQueue;
let events: LiveEventLog;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mania-sweeps-status-"));
  db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
  await migrate(db);
  queue = new JobQueue(db);
  events = new LiveEventLog(db);
});

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

async function seedMeta(key: string, valueJson: string, updatedAt = new Date().toISOString()): Promise<void> {
  await exec(
    db,
    "insert or replace into live_meta (key, value_json, updated_at) values (?, ?, ?)",
    [key, valueJson, updatedAt],
  );
}

async function report(id: string) {
  const reports = await getSweepReports(db);
  const found = reports.find((entry) => entry.id === id);
  expect(found, `sweep ${id} missing from registry`).toBeDefined();
  return found!;
}

describe("sweeps status registry", () => {
  it("returns an entry for every known sweep", async () => {
    const reports = await getSweepReports(db);
    const ids = reports.map((entry) => entry.id);
    expect(ids).toEqual([
      "chart-family-backfill",
      "player-skill-dan-recompute",
      "activity-mods-backfill",
      "activity-combo-backfill",
      "top-scores-backfill",
      "skill-vector-backfill-v5",
      "osu-file-repair",
      "dt-rate-analysis",
      "vibro-recompute",
      "dan-eligibility-recompute",
      "note-bpm-recompute",
      "dan-floor-pin-recompute",
      "ln-subtype-recompute",
      "companella-recompute",
      "chordjack-tag-recompute",
      "jack-demand-recompute",
      "motion-features-recompute",
      "bracket-tag-recompute",
      "bracket-content-recompute",
      "ln-msd-backfill",
      "ln-source-recompute",
      "ln-leoblack-recompute",
      "sunny-repin-recompute",
      "sunny-repin-dt-recompute",
      "leoblack-repin-recompute",
      "leoblack-repin-dt-recompute",
      "msd-poison-recovery",
      "nkey-msd",
      "inverse-cluster-bpm",
      "skill-baseline",
      "map-search-index",
      "skin-slug-backfill",
    ]);
    for (const entry of reports) {
      expect(entry.label).toBeTruthy();
      expect(entry.description).toBeTruthy();
      expect(["one-time", "recurring"]).toContain(entry.kind);
      expect(["done", "running", "pending", "unknown"]).toContain(entry.status);
    }
  });

  it("reports pending for sweeps with no state at all", async () => {
    const entry = await report("top-scores-backfill");
    expect(entry.status).toBe("pending");
    expect(entry.detail).toBe("not started");
  });

  it("shows the family backfill chain and the dan dependency waiting on it", async () => {
    expect((await report("player-skill-dan-recompute")).detail).toContain("chart families");
    await queue.enqueue(CHART_FAMILY_SWEEP_JOB, "families:100", { cursor: 100 });
    expect(await report("chart-family-backfill")).toMatchObject({ status: "running", progress: { cursor: 100 } });
    await seedMeta(CHART_FAMILY_META_KEY, "{}");
    expect((await report("chart-family-backfill")).status).toBe("done");
    expect((await report("player-skill-dan-recompute")).detail).not.toContain("chart families");
  });

  it("uses the current dan revision and shows a repair rerun over its old completion", async () => {
    await seedMeta("player_skill_dan_sweep_done:v28", "{}");
    expect((await report("player-skill-dan-recompute")).status).toBe("pending");
    await seedMeta(PLAYER_SKILL_DAN_SWEEP_META_KEY, "{}");
    expect((await report("player-skill-dan-recompute")).status).toBe("done");
    await queue.enqueue(PLAYER_SKILL_DAN_SWEEP_JOB, "dan:200", { cursor: 200 });
    expect(await report("player-skill-dan-recompute")).toMatchObject({ status: "running", progress: { cursor: 200 } });
  });

  it("reports done when the done key exists", async () => {
    await seedMeta(
      TOP_SCORES_BACKFILL_DONE_META_KEY,
      JSON.stringify({ finishedAt: "2026-07-01T00:00:00.000Z", processed: 4850, fetched: 4100, missing: 700, failed: 3 }),
    );
    const entry = await report("top-scores-backfill");
    expect(entry.status).toBe("done");
    expect(entry.progress?.processed).toBe(4850);
    expect(entry.progress?.fetched).toBe(4100);
  });

  it("reports running when progress exists without a done key and a chain job is queued", async () => {
    // Stale progress so the recency fallback cannot be what flips it to running.
    await seedMeta(
      TOP_SCORES_BACKFILL_PROGRESS_META_KEY,
      JSON.stringify({ cursor: 12345, processed: 400, fetched: 350, missing: 50, failed: 1, updatedAt: "2026-07-01T00:00:00.000Z" }),
      "2026-07-01T00:00:00.000Z",
    );
    await queue.enqueue(TOP_SCORES_BACKFILL_JOB, `${TOP_SCORES_BACKFILL_JOB}:12345`, { cursor: 12345 });
    const entry = await report("top-scores-backfill");
    expect(entry.status).toBe("running");
    expect(entry.progress?.processed).toBe(400);
    expect(entry.progress?.cursor).toBe(12345);
    // Empty roster: nothing remains, so the total collapses to processed.
    expect(entry.progress?.total).toBe(400);
  });

  it("reports running from recent progress movement when no chain job is visible", async () => {
    await seedMeta(
      TOP_SCORES_BACKFILL_PROGRESS_META_KEY,
      JSON.stringify({ cursor: 99, processed: 10, fetched: 9, missing: 1, failed: 0 }),
      new Date().toISOString(),
    );
    const entry = await report("top-scores-backfill");
    expect(entry.status).toBe("running");
  });

  it("reports pending with progress when the chain is stale and jobless", async () => {
    await seedMeta(
      TOP_SCORES_BACKFILL_PROGRESS_META_KEY,
      JSON.stringify({ cursor: 99, processed: 10, fetched: 9, missing: 1, failed: 0 }),
      "2026-07-01T00:00:00.000Z",
    );
    const entry = await report("top-scores-backfill");
    expect(entry.status).toBe("pending");
    expect(entry.progress?.processed).toBe(10);
  });

  it("reports unknown for garbage progress JSON without crashing", async () => {
    await seedMeta(TOP_SCORES_BACKFILL_PROGRESS_META_KEY, "not json {{{");
    const entry = await report("top-scores-backfill");
    expect(entry.status).toBe("unknown");
    expect(entry.detail).toMatch(/not valid JSON/);
  });

  it("reads the skill-vector v5 contract keys", async () => {
    await seedMeta(
      "skill_vector_backfill_progress:v5",
      JSON.stringify({ cursor: 777, processed: 120, computed: 100, unavailable: 15, failed: 5, updatedAt: new Date().toISOString() }),
    );
    const running = await report("skill-vector-backfill-v5");
    expect(running.status).toBe("running");
    expect(running.progress?.computed).toBe(100);

    await seedMeta("skill_vector_backfill_done:v5", JSON.stringify({ finishedAt: "2026-07-30T00:00:00.000Z", processed: 200 }));
    const done = await report("skill-vector-backfill-v5");
    expect(done.status).toBe("done");
  });

  it("treats the DT-rate sweep done key as done and a queued chunk as running", async () => {
    await queue.enqueue("recompute_dt_rate_analysis_sweep", "recompute_dt_rate_analysis_sweep:0", { cursor: 0 });
    const running = await report("dt-rate-analysis");
    expect(running.status).toBe("running");
    expect(running.progress?.cursor).toBe(0);

    await exec(db, "delete from jobs");
    await seedMeta("dt_rate_analysis_done:v2", JSON.stringify({ finishedAt: "2026-06-01T00:00:00.000Z" }));
    const done = await report("dt-rate-analysis");
    expect(done.status).toBe("done");
  });

  it("summarizes the skill baseline fold from the curves blob and in-flight jobs", async () => {
    const pending = await report("skill-baseline");
    expect(pending.status).toBe("pending");

    await seedMeta(
      SKILL_BASELINE_CURVES_META_KEY,
      JSON.stringify({ computedAt: "2026-07-20T00:00:00.000Z", users: { "4": 3000, "7": 1200 } }),
    );
    const done = await report("skill-baseline");
    expect(done.status).toBe("done");
    expect(done.updatedAt).toBe("2026-07-20T00:00:00.000Z");
    expect(done.progress?.users).toBe(4200);
    expect(done.detail).toContain("4K 3000");

    await queue.enqueue("refresh_skill_baseline", "refresh_skill_baseline:run:0", { runId: "run", cursor: 0 });
    const running = await report("skill-baseline");
    expect(running.status).toBe("running");

    await seedMeta(SKILL_BASELINE_CURVES_META_KEY, "garbage{{");
    await exec(db, "delete from jobs");
    const unknown = await report("skill-baseline");
    expect(unknown.status).toBe("unknown");
  });

  it("tracks the map search index build across revisions", async () => {
    const pending = await report("map-search-index");
    expect(pending.status).toBe("pending");

    await seedMeta("map_search_index_build_cursor:v5:r7", JSON.stringify({ cursor: 4200 }));
    await queue.enqueue("build_map_search_index", "build_map_search_index:4200", { cursor: 4200 });
    const running = await report("map-search-index");
    expect(running.status).toBe("running");
    expect(running.progress?.cursor).toBe(4200);

    await exec(db, "delete from jobs");
    await seedMeta("map_search_index_built:v5:r7", JSON.stringify({ builtAt: "2026-07-10T00:00:00.000Z" }));
    const done = await report("map-search-index");
    expect(done.status).toBe("done");
    expect(done.detail).toBe("map_search_index_built:v5:r7");
  });

  it("reports the skin slug backfill from its boot marker", async () => {
    const pending = await report("skin-slug-backfill");
    expect(pending.status).toBe("pending");
    await seedMeta("skin_slug_backfill:v1", JSON.stringify({ backfilled: 12 }));
    const done = await report("skin-slug-backfill");
    expect(done.status).toBe("done");
    expect(done.progress?.backfilled).toBe(12);
  });
});

// ── Endpoint ─────────────────────────────────────────────────────────────────

const TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function ctx(configOverrides: Record<string, unknown> = {}) {
  return {
    db,
    queue,
    events,
    abuse: new AbuseGuard(),
    config: {
      nodeEnv: "development",
      liveAdminToken: undefined,
      allowedOrigins: ["http://localhost:3000"],
      trackedCountries: ["CR"],
      trustProxyHeaders: true,
      publicApiRatePerMinute: 240,
      publicCostlyRatePerMinute: 60,
      ...configOverrides,
    },
    osu: { limiter: { state: () => ({ hardPerMinute: 60, usedLastMinute: 0 }) } },
    oscStatus: () => ({ connected: false, lastBatchAt: null, lastError: null }),
  } as never;
}

function mockReq(url: string, headers: IncomingMessage["headers"] = {}): IncomingMessage {
  const req = new EventEmitter() as IncomingMessage;
  req.method = "GET";
  req.url = url;
  req.headers = { host: "localhost", ...headers };
  return req;
}

function mockRes() {
  const writes: string[] = [];
  const headers: Record<string, string> = {};
  const res = Object.assign(new EventEmitter(), {
    statusCode: 200,
    setHeader: (key: string, value: number | string | readonly string[]) => {
      headers[key.toLowerCase()] = Array.isArray(value) ? value.join(",") : String(value);
    },
    getHeader: (key: string) => headers[key.toLowerCase()],
    writeHead: (status: number) => {
      res.statusCode = status;
      return res;
    },
    write: (chunk: string | Buffer) => {
      writes.push(String(chunk));
      return true;
    },
    destroy: () => {},
    end: (chunk?: string | Buffer) => {
      if (chunk != null) writes.push(String(chunk));
    },
  }) as unknown as ServerResponse & { statusCode: number };
  return { res, writes };
}

async function call(url: string, headers: IncomingMessage["headers"] = {}, configOverrides: Record<string, unknown> = {}) {
  const response = mockRes();
  await routeHttp(mockReq(url, headers), response.res, ctx(configOverrides));
  const raw = response.writes.join("");
  let body: ReturnType<typeof JSON.parse> = null;
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch {
    body = raw;
  }
  return { status: response.res.statusCode, body };
}

describe("GET /api/admin/sweeps", () => {
  it("rejects unauthorized requests", async () => {
    const result = await call("/api/admin/sweeps", {}, { liveAdminToken: TOKEN });
    expect(result.status).toBe(401);
    expect(result.body).toEqual({ error: "unauthorized" });
  });

  it("returns the sweep reports with a valid token", async () => {
    await seedMeta("dt_rate_analysis_done:v2", JSON.stringify({ finishedAt: "2026-06-01T00:00:00.000Z" }));
    const result = await call("/api/admin/sweeps", { authorization: `Bearer ${TOKEN}` }, { liveAdminToken: TOKEN });
    expect(result.status).toBe(200);
    expect(Array.isArray(result.body?.sweeps)).toBe(true);
    expect(result.body.sweeps.length).toBeGreaterThanOrEqual(13);
    const dt = result.body.sweeps.find((entry: { id: string }) => entry.id === "dt-rate-analysis");
    expect(dt?.status).toBe("done");
    expect(dt?.kind).toBe("one-time");
    for (const entry of result.body.sweeps) {
      expect(typeof entry.id).toBe("string");
      expect(typeof entry.label).toBe("string");
      expect(["done", "running", "pending", "unknown"]).toContain(entry.status);
    }
  });
});
