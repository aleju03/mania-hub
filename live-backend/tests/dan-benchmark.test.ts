import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, migrate, type Db } from "../src/db.js";
import {
  importDanBenchmark,
  listDanBenchmarkHiddenDiffs,
  listDanBenchmarkLabels,
  setDanBenchmarkHiddenDiff,
  setDanBenchmarkLabel,
} from "../src/features/dan-benchmark.js";

let dir = "";
let db: Db;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mania-dan-bench-"));
  db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
  await migrate(db);
});

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("dan benchmark labels", () => {
  it("round-trips a label and scopes list by family", async () => {
    expect(await setDanBenchmarkLabel(db, { beatmapId: 100, family: "normal", expectedLabel: "10" })).toBe(true);
    expect(await setDanBenchmarkLabel(db, { beatmapId: 200, family: "ln", expectedLabel: "gamma" })).toBe(true);

    const normal = await listDanBenchmarkLabels(db, "normal");
    expect(normal).toHaveLength(1);
    expect(normal[0]).toMatchObject({ beatmapId: 100, expectedLabel: "10", family: "normal" });
    expect(normal[0].updatedAt).toBeGreaterThan(0);
    expect(await listDanBenchmarkLabels(db, "ln")).toHaveLength(1);
    expect(await listDanBenchmarkLabels(db, "ranked")).toHaveLength(0);
  });

  it("upserts on beatmap_id and clears on null/empty label", async () => {
    await setDanBenchmarkLabel(db, { beatmapId: 100, family: "normal", expectedLabel: "10" });
    await setDanBenchmarkLabel(db, { beatmapId: 100, family: "ln", expectedLabel: "delta" });
    expect(await listDanBenchmarkLabels(db, "normal")).toHaveLength(0);
    expect((await listDanBenchmarkLabels(db, "ln"))[0]).toMatchObject({ beatmapId: 100, expectedLabel: "delta" });

    await setDanBenchmarkLabel(db, { beatmapId: 100, family: "ln", expectedLabel: null });
    expect(await listDanBenchmarkLabels(db, "ln")).toHaveLength(0);
    await setDanBenchmarkLabel(db, { beatmapId: 100, family: "ln", expectedLabel: "delta" });
    await setDanBenchmarkLabel(db, { beatmapId: 100, family: "ln", expectedLabel: "" });
    expect(await listDanBenchmarkLabels(db, "ln")).toHaveLength(0);
  });

  it("rejects invalid ids and families", async () => {
    expect(await setDanBenchmarkLabel(db, { beatmapId: 0, family: "normal", expectedLabel: "10" })).toBe(false);
    expect(await setDanBenchmarkLabel(db, { beatmapId: 5, family: "nope", expectedLabel: "10" })).toBe(false);
  });
});

describe("dan benchmark hidden diffs", () => {
  it("hides, lists by family, and unhides", async () => {
    await setDanBenchmarkHiddenDiff(db, { beatmapId: 300, family: "normal", hidden: true });
    await setDanBenchmarkHiddenDiff(db, { beatmapId: 400, family: "ln", hidden: true });
    expect(await listDanBenchmarkHiddenDiffs(db, "normal")).toEqual([300]);
    expect(await listDanBenchmarkHiddenDiffs(db, "ln")).toEqual([400]);

    await setDanBenchmarkHiddenDiff(db, { beatmapId: 300, family: "normal", hidden: false });
    expect(await listDanBenchmarkHiddenDiffs(db, "normal")).toEqual([]);
  });
});

describe("dan benchmark import", () => {
  const payload = {
    labels: [
      { beatmap_id: 523391, expected_label: "10", family: "normal", updated_at: 1778368423214 },
      { beatmap_id: 111, expected_label: "alpha", family: "ln", updated_at: 1778368400000 },
      { beatmap_id: -1, expected_label: "bad", family: "normal", updated_at: 1 },
    ],
    hidden: [
      { beatmap_id: 999, family: "normal", updated_at: 1778368423214 },
      { beatmap_id: 5, family: "nope", updated_at: 1 },
    ],
  };

  it("imports the Turso export shape, preserving updated_at and skipping bad rows", async () => {
    const result = await importDanBenchmark(db, payload);
    expect(result).toEqual({ labels: 2, hidden: 1, skipped: 2 });

    const normal = await listDanBenchmarkLabels(db, "normal");
    expect(normal[0]).toMatchObject({ beatmapId: 523391, expectedLabel: "10", updatedAt: 1778368423214 });
    expect(await listDanBenchmarkHiddenDiffs(db, "normal")).toEqual([999]);
  });

  it("is idempotent", async () => {
    await importDanBenchmark(db, payload);
    const again = await importDanBenchmark(db, payload);
    expect(again).toEqual({ labels: 2, hidden: 1, skipped: 2 });
    expect(await listDanBenchmarkLabels(db, "normal")).toHaveLength(1);
    expect(await listDanBenchmarkLabels(db, "ln")).toHaveLength(1);
    expect(await listDanBenchmarkHiddenDiffs(db, "normal")).toEqual([999]);
  });
});
