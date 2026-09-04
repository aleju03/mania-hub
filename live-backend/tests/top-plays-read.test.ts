import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, exec, execBatch, migrate, type Db } from "../src/db.js";
import { getTopPlaysSnapshot, type TopPlaysSnapshotOptions } from "../src/features/top-plays.js";
import { sendTopPlaysSnapshot } from "../src/http/top-plays-response-cache.js";
import type { HttpContext } from "../src/http/context.js";
import type { IncomingMessage, ServerResponse } from "node:http";

let dir: string;
let db: Db;
const now = Date.parse("2026-09-04T12:00:00.000Z");
const rows = Array.from({ length: 2_800 }, (_, i) => ({
  id: i + 1,
  userId: i % 4 + 1,
  country: i % 2 ? "CR" : "US",
  keys: i % 2 ? 4 : 7,
  // Historical high scores must not force an unbounded PP/gain index scan
  // when a busy new day still contains thousands of lower-valued scores.
  pp: i < 400 ? 2_000 + i : i % 101,
  gain: i < 400 ? 1_000 + i : i % 17,
  time: new Date(now - (i < 400 ? 10 * 86_400_000 : i * 1000)).toISOString(),
  detectedAt: new Date(now - i * 500).toISOString(),
}));

beforeEach(async () => {
  vi.spyOn(Date, "now").mockReturnValue(now);
  dir = await mkdtemp(join(tmpdir(), "mania-top-plays-read-"));
  db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
  await migrate(db);
  await execBatch(db, rows.map((row) => ({
    sql: `insert into top_play_events (country, score_id, user_id, pp, weighted_pp, pp_gain, payload_json, detected_at, score_time, key_count)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [row.country, row.id, row.userId, row.pp, row.pp, row.gain,
      JSON.stringify({ score: { id: row.id, user_id: row.userId }, time: row.time }), row.detectedAt, row.time, row.keys],
  })));
});

afterEach(async () => {
  db?.close();
  vi.restoreAllMocks();
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("top-play read plans", () => {
  it("keeps sort, ties, windows, keys, users, country and deep-page results identical", async () => {
    for (const sort of ["pp", "gain", "recent"] as const) {
      for (const dir of ["asc", "desc"] as const) {
        for (const window of ["24h", "7d", "30d"] as const) {
          for (const variant of [{}, { keys: "4k" }, { keys: "other", page: 30 }, { userIds: [2] }] satisfies TopPlaysSnapshotOptions[]) {
            const options: TopPlaysSnapshotOptions = { sort, dir, pageSize: 20, ...variant };
            const days = window === "24h" ? 1 : window === "7d" ? 7 : 30;
            const expected = rows.filter((row) => Date.parse(row.time) >= now - days * 86_400_000
              && (options.keys !== "4k" || row.keys === 4)
              && (options.keys !== "other" || row.keys !== 4)
              && (!options.userIds || options.userIds.includes(row.userId)));
            const sign = dir === "asc" ? 1 : -1;
            expected.sort((a, b) => sort === "recent"
              ? sign * (a.time.localeCompare(b.time) || a.detectedAt.localeCompare(b.detectedAt)) || b.pp - a.pp
              : sign * ((sort === "gain" ? a.gain - b.gain : a.pp - b.pp)) || b.time.localeCompare(a.time) || b.detectedAt.localeCompare(a.detectedAt));
            const offset = ((options.page ?? 1) - 1) * 20;
            const actual = await getTopPlaysSnapshot(db, "GLOBAL", window, options);
            expect(actual.total).toBe(expected.length);
            expect(actual.popoffs.map((play) => play.score.id)).toEqual(expected.slice(offset, offset + 20).map((row) => row.id));
          }
        }
      }
    }
    const country = await getTopPlaysSnapshot(db, "CR", "30d", { sort: "pp", pageSize: 20 });
    expect(country.popoffs.map((play) => play.score.id)).toEqual(rows.filter((row) => row.country === "CR").sort((a, b) => b.pp - a.pp || b.time.localeCompare(a.time) || b.detectedAt.localeCompare(a.detectedAt)).slice(0, 20).map((row) => row.id));
  });

  it("shares prepared response work, separates filters, and invalidates on new events and TTL", async () => {
    const querySpy = vi.spyOn(db, "execute");
    const ctx = { db, config: { allowedOrigins: [] }, queue: null } as unknown as HttpContext;
    const request = { headers: {} } as IncomingMessage;
    const run = async (options: TopPlaysSnapshotOptions = {}) => {
      let body = "";
      const headers = new Map();
      const response = {
        setHeader: (key: string, value: unknown) => { headers.set(key, value); },
        getHeader: (key: string) => headers.get(key),
        end: (chunk: Buffer) => { body = String(chunk); },
      } as unknown as ServerResponse;
      await sendTopPlaysSnapshot(request, response, ctx, "GLOBAL", "30d", { pageSize: 20, ...options });
      return body;
    };
    const countQueries = () => querySpy.mock.calls.filter(([statement]) => /select count\(\*\) as count\s+from top_play_events/.test(typeof statement === "string" ? statement : (statement as { sql: string }).sql)).length;
    const [first, second] = await Promise.all([run(), run()]);
    expect(second).toBe(first);
    expect(countQueries()).toBe(1);
    await run({ keys: "4k" });
    expect(countQueries()).toBe(2);
    await exec(db, `insert into top_play_events (country, score_id, user_id, pp, weighted_pp, pp_gain, payload_json, detected_at, score_time, key_count)
      values ('CR', 99001, 1, 9999, 9999, 1, '{"score":{"id":99001}}', ?, ?, 4)`, [new Date(now).toISOString(), new Date(now).toISOString()]);
    expect(JSON.parse(await run()).popoffs[0].score.id).toBe(99001);
    expect(countQueries()).toBe(3);
    vi.mocked(Date.now).mockReturnValue(now + 5_001);
    await run();
    expect(countQueries()).toBe(4);
  });
});
