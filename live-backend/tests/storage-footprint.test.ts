import { mkdir, mkdtemp, rm, statfs, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDbDiskUsage, getDiskUsage, getStorageFootprint } from "../src/retention.js";

let dir = "";
let dataDir = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mania-storage-footprint-"));
  dataDir = join(dir, "data");
  await mkdir(dataDir, { recursive: true });
});

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

function bytes(size: number): Uint8Array {
  return new Uint8Array(size);
}

describe("getDiskUsage", () => {
  it("reports usage the way df does", async () => {
    const stats = await statfs(dir);
    const usage = await getDiskUsage(dir);
    expect(usage).not.toBeNull();
    if (!usage) return;

    const used = (stats.blocks - stats.bfree) * stats.bsize;
    const avail = stats.bavail * stats.bsize;
    expect(usage.path).toBe(dir);
    // The two statfs calls are separated by real time on a live filesystem, so
    // compare within a tolerance rather than for byte equality: parallel vitest
    // workers writing temp databases move these numbers between the samples.
    const tolerance = Math.max(64 * 1024 * 1024, used * 0.01);
    expect(Math.abs(usage.usedBytes - used)).toBeLessThan(tolerance);
    expect(Math.abs(usage.freeBytes - avail)).toBeLessThan(tolerance);
    // Total capacity does not move, so this one stays exact.
    expect(usage.totalBytes).toBe(stats.blocks * stats.bsize);
    // Root-reserved blocks count as neither used nor available.
    expect(usage.usedPct).toBeCloseTo((used / (used + avail)) * 100, 1);
    if (stats.bfree !== stats.bavail) {
      expect(usage.usedPct).not.toBeCloseTo(((stats.blocks - stats.bfree) / stats.blocks) * 100, 1);
    }
  });

  it("labels the configured warn and critical thresholds", async () => {
    const usage = await getDiskUsage(dir);
    expect(usage).not.toBeNull();
    if (!usage) return;
    expect(usage.warnPct).toBe(70);
    expect(usage.criticalPct).toBe(85);
    const expected = usage.usedPct >= 85 ? "critical" : usage.usedPct >= 70 ? "warn" : "ok";
    expect(usage.level).toBe(expected);
  });

  it("returns null for a path that does not exist", async () => {
    expect(await getDiskUsage(join(dir, "nope", "still-nope"))).toBeNull();
  });
});

describe("getDbDiskUsage", () => {
  it("measures the filesystem holding a local database", async () => {
    const usage = await getDbDiskUsage({ databaseUrl: `file:${join(dataDir, "test.db")}` });
    expect(usage?.path).toBe(dataDir);
  });

  it("returns null when the database is not local", async () => {
    expect(await getDbDiskUsage({ databaseUrl: "libsql://example.turso.io" })).toBeNull();
    expect(await getDbDiskUsage({ databaseUrl: "file::memory:" })).toBeNull();
  });
});

describe("getStorageFootprint", () => {
  it("measures the database, analytics, backup and work-dir paths", async () => {
    const dbPath = join(dataDir, "test.db");
    const analyticsPath = join(dataDir, "analytics.db");
    await writeFile(dbPath, bytes(4096));
    await writeFile(`${dbPath}-wal`, bytes(2048));
    await writeFile(`${dbPath}-shm`, bytes(32));
    await writeFile(analyticsPath, bytes(1024));
    await writeFile(`${analyticsPath}-wal`, bytes(512));
    await mkdir(join(dataDir, "backups", "online-20260101-000000"), { recursive: true });
    await writeFile(join(dataDir, "backups", "online-20260101-000000", "mania-hub-live.db.zst"), bytes(8192));
    const workDir = join(dataDir, "replay-video-jobs");
    await mkdir(workDir, { recursive: true });
    await writeFile(join(workDir, "job.json"), bytes(64));

    const footprint = await getStorageFootprint({
      databaseUrl: `file:${dbPath}`,
      analyticsDatabaseUrl: `file:${analyticsPath}`,
      replayVideoWorkDir: workDir,
    });

    expect(footprint).toEqual({
      db: 4096,
      dbWal: 2048,
      dbShm: 32,
      analytics: 1024,
      analyticsWal: 512,
      backups: 8192,
      replayVideoWork: 64,
    });
  });

  it("tolerates missing optional config fields and absent files", async () => {
    const dbPath = join(dataDir, "test.db");
    await writeFile(dbPath, bytes(128));

    const footprint = await getStorageFootprint({ databaseUrl: `file:${dbPath}` });
    expect(footprint).toEqual({
      db: 128,
      dbWal: null,
      dbShm: null,
      analytics: null,
      analyticsWal: null,
      // No backups dir and no work dir: null, not zero.
      backups: null,
      replayVideoWork: null,
    });

    // The same shape when the optional keys are present but undefined, which is
    // what a partially-built config hands over at runtime.
    expect(
      await getStorageFootprint({
        databaseUrl: `file:${dbPath}`,
        analyticsDatabaseUrl: undefined,
        replayVideoWorkDir: undefined,
      }),
    ).toEqual(footprint);
  });

  it("returns nulls for a non-local database", async () => {
    const footprint = await getStorageFootprint({ databaseUrl: "libsql://example.turso.io" });
    expect(Object.values(footprint).every((value) => value === null)).toBe(true);
  });

  it("bounds the backups walk by depth", async () => {
    const dbPath = join(dataDir, "test.db");
    await writeFile(dbPath, bytes(16));
    const deep = join(dataDir, "backups", "a", "b", "c", "d");
    await mkdir(deep, { recursive: true });
    await writeFile(join(dataDir, "backups", "a", "b", "c", "counted.bin"), bytes(256));
    await writeFile(join(deep, "ignored.bin"), bytes(4096));

    const footprint = await getStorageFootprint({ databaseUrl: `file:${dbPath}` });
    expect(footprint.backups).toBe(256);
  });

  it("memoises directory sizes so admin polling does not re-walk the tree", async () => {
    const dbPath = join(dataDir, "test.db");
    await writeFile(dbPath, bytes(16));
    const backups = join(dataDir, "backups");
    await mkdir(backups, { recursive: true });
    await writeFile(join(backups, "first.bin"), bytes(100));

    const first = await getStorageFootprint({ databaseUrl: `file:${dbPath}` });
    expect(first.backups).toBe(100);

    await writeFile(join(backups, "second.bin"), bytes(100));
    const second = await getStorageFootprint({ databaseUrl: `file:${dbPath}` });
    expect(second.backups).toBe(100);
  });
});
