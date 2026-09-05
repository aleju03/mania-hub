import { afterEach, describe, expect, it, vi } from "vitest";
import { once, EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createDb, exec, migrate } from "../src/db.js";
import { createModuleWorker } from "../src/module-worker.js";
import { getMapSearchPage } from "../src/features/map-search.js";
import { parseMapSearchQuery } from "../src/http/snapshot-queries.js";
import { handleSnapshotRoutes } from "../src/http/routes/snapshots.js";
import { prepareJsonResponse } from "../src/http/prepared-json.js";
import * as snapshotThread from "../src/http/maps-snapshot-thread.js";
import type { HttpContext } from "../src/http/context.js";

afterEach(() => vi.restoreAllMocks());

describe("maps search thread", () => {
  it("builds the same filtered pages and compressed payloads on the worker connection", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mania-mapsearch-thread-"));
    const databaseUrl = `file:${join(dir, "test.db")}`;
    const db = await createDb({ databaseUrl });
    let worker: ReturnType<typeof createModuleWorker> | undefined;
    try {
      await migrate(db);
      for (let id = 1; id <= 12; id++) {
        await exec(db, `insert into map_search_index
          (beatmap_id, beatmapset_id, analysis_version, title, artist, version, search_text,
           key_count, stars, bpm, length, status, play_count, primary_pattern, updated_at)
          values (?, ?, 1, 'Test map', 'Test artist', 'Hard', 'test map artist hard', 4, ?, 180, 120, 'ranked', ?, 'stream', '2026-09-01')`,
        [id, Math.ceil(id / 2), id, id * 100]);
      }
      worker = createModuleWorker(new URL("../src/http/maps-snapshot-thread-worker.js", import.meta.url), {
        workerData: { databaseUrl, sqliteBusyTimeoutMs: 0, sqliteCacheMb: 2, sqliteMmapMb: 0 },
      });
      let ticks = 0;
      const timer = setInterval(() => ticks++, 1);
      try {
        for (const encoding of [null, "gzip", "br"] as const) {
          const query = parseMapSearchQuery(new URLSearchParams("q=test&starMin=3&sort=stars&dir=desc&pageSize=3"));
          const expected = await getMapSearchPage(db, query);
          const responsePromise = once(worker, "message");
          worker.postMessage({ id: 1, kind: "maps-search", query, encoding });
          const [response] = await responsePromise as [snapshotThread.MapsSnapshotThreadResponse];
          expect(response.ok).toBe(true);
          if (!response.ok || response.kind === "compute") throw new Error("unexpected worker response");
          expect(response.kind).toBe("maps-search");
          expect(response.status).toBe(200);
          expect(response.encoding).toBe(encoding);
          const body = response.encoding === "br" ? brotliDecompressSync(response.body)
            : response.encoding === "gzip" ? gunzipSync(response.body) : Buffer.from(response.body);
          expect(JSON.parse(body.toString())).toEqual(expected);
        }
        expect(ticks).toBeGreaterThan(0);
      } finally {
        clearInterval(timer);
      }
    } finally {
      await worker?.terminate();
      db.close();
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("single-flights and caches thread builds without querying the serving connection", async () => {
    const prepared = await prepareJsonResponse(200, { items: [], total: 0, page: 0, pageSize: 50 }, null);
    const build = vi.fn().mockResolvedValue(prepared);
    vi.spyOn(snapshotThread, "getMapsSnapshotThread").mockReturnValue({ available: () => true, build } as never);
    const ctx = context();
    const serve = async () => {
      const { req, res, body } = request();
      await handleSnapshotRoutes(req, res, ctx, new URL(req.url!, "http://localhost"), "CR");
      expect(JSON.parse(body())).toMatchObject({ total: 0 });
    };
    await Promise.all([serve(), serve()]);
    await serve();
    expect(build).toHaveBeenCalledTimes(1);
    expect(build.mock.calls[0][0]).toMatchObject({ kind: "maps-search", encoding: null });
    expect(ctx.db.execute).not.toHaveBeenCalled();
  });

  it.each(["spawn failure", "build failure", "cooldown"])("returns an uncached 503 after %s without an inline retry", async (reason) => {
    const build = vi.fn().mockRejectedValue(reason === "build failure"
      ? new snapshotThread.MapsSnapshotBuildError(reason) : new Error(reason));
    vi.spyOn(snapshotThread, "getMapsSnapshotThread").mockReturnValue({
      available: () => reason !== "cooldown", build,
    } as never);
    const ctx = context();
    const { req, res, headers, body } = request();
    await handleSnapshotRoutes(req, res, ctx, new URL(req.url!, "http://localhost"), "CR");
    expect(res.statusCode).toBe(503);
    expect(headers.get("cache-control")).toBe("no-store");
    expect(headers.get("retry-after")).toBe("5");
    expect(JSON.parse(body())).toEqual({ error: "maps_search_unavailable" });
    expect(ctx.db.execute).not.toHaveBeenCalled();
  });
});

function context(): HttpContext {
  return {
    db: { execute: vi.fn(() => { throw new Error("search used the serving connection"); }) },
    config: { databaseUrl: "file:/unused.db", allowedOrigins: [] },
  } as unknown as HttpContext;
}

function request() {
  const req = Object.assign(new EventEmitter(), {
    method: "GET", url: "/api/snapshots/maps-search?q=test", headers: { host: "localhost" },
  }) as IncomingMessage;
  const headers = new Map<string, unknown>();
  let output = "";
  const res = {
    statusCode: 200,
    setHeader: (name: string, value: unknown) => headers.set(name.toLowerCase(), value),
    getHeader: (name: string) => headers.get(name.toLowerCase()),
    end: (chunk: string | Buffer) => { output += String(chunk ?? ""); },
  } as unknown as ServerResponse;
  return { req, res, headers, body: () => output };
}
