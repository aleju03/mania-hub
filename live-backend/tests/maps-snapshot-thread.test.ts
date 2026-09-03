import { afterEach, describe, expect, it } from "vitest";
import { computeOnMapsSnapshotThread, getMapsSnapshotThread, mapsSnapshotThreadStatus, registerOffThreadBoardBuilds } from "../src/http/maps-snapshot-thread.js";
import type { Db } from "../src/db.js";

// Under vitest (and under `npm run dev`) this module is loaded from source, so
// the thread is permanently disabled with reason "source_mode": its worker
// entry resolves a `.js` specifier that tsx does not remap inside a worker.
// These tests therefore assert the disabled/idle contract — the shape the admin
// dashboard has to render when no thread exists — not live build counters.

const originalEnvFlag = process.env.MAPS_SNAPSHOT_THREAD;

afterEach(() => {
  if (originalEnvFlag == null) delete process.env.MAPS_SNAPSHOT_THREAD;
  else process.env.MAPS_SNAPSHOT_THREAD = originalEnvFlag;
});

describe("mapsSnapshotThreadStatus", () => {
  it("reports the idle shape when no thread has ever been constructed", () => {
    const status = mapsSnapshotThreadStatus({ databaseUrl: "file:/tmp/mania-hub-thread-status.db" });

    expect(status).toMatchObject({
      enabled: false,
      disabledReason: "source_mode",
      spawned: false,
      everOnline: false,
      available: true,
      cooldownMsRemaining: 0,
      inFlight: 0,
      requested: 0,
      ok: 0,
      failed: 0,
      timeouts: 0,
      lastBuildMs: null,
      lastBuildAt: null,
      lastBuildKind: null,
      lastBuildBytes: null,
      lastErrorAt: null,
      lastError: null,
      lastFailureReason: null,
    });
  });

  it("distinguishes why the thread is unavailable", () => {
    expect(mapsSnapshotThreadStatus({}).disabledReason).toBe("not_file_db");
    expect(mapsSnapshotThreadStatus({ databaseUrl: "libsql://example.turso.io" }).disabledReason).toBe("not_file_db");
    // The env kill switch is checked before source mode, so it wins here.
    process.env.MAPS_SNAPSHOT_THREAD = "0";
    expect(mapsSnapshotThreadStatus({ databaseUrl: "file:/tmp/mania-hub-thread-status.db" }).disabledReason).toBe("env_disabled");
  });

  it("does not construct a thread as a side effect of being asked", () => {
    const databaseUrl = "file:/tmp/mania-hub-thread-status-side-effect.db";
    // getMapsSnapshotThread is the only registration path; while the thread is
    // disabled it must not register either, so status stays "never constructed"
    // however many times anything asks.
    expect(getMapsSnapshotThread({ databaseUrl })).toBeNull();
    for (let i = 0; i < 3; i++) {
      expect(mapsSnapshotThreadStatus({ databaseUrl }).spawned).toBe(false);
    }
    expect(mapsSnapshotThreadStatus({ databaseUrl }).requested).toBe(0);
  });
});

describe("computeOnMapsSnapshotThread", () => {
  // The board builders (pack pool, skill leaderboard) call this first and build
  // inline on null. Both of these are the null case: an unregistered connection
  // (tests, the headless worker) and a registered one where no thread can run.
  it("returns null for a connection that never registered", async () => {
    const db = {} as Db;
    await expect(computeOnMapsSnapshotThread(db, { kind: "skill-board" })).resolves.toBeNull();
  });

  it("returns null, without spawning, when the thread is disabled here", async () => {
    const db = {} as Db;
    const databaseUrl = "file:/tmp/mania-hub-thread-compute.db";
    registerOffThreadBoardBuilds(db, { databaseUrl });
    await expect(computeOnMapsSnapshotThread(db, { kind: "pack-pool-unranked" })).resolves.toBeNull();
    expect(mapsSnapshotThreadStatus({ databaseUrl })).toMatchObject({ enabled: false, spawned: false, requested: 0 });
  });
});
