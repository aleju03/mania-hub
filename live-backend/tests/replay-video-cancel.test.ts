import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { createDb, migrate, type Db } from "../src/db.js";
import { cancelReplayVideoExport } from "../src/replay-video/exports.js";

// Cancel is the one replay-video action that never looks its row up first: it
// deletes the job's directory outright. The id therefore has to be checked
// before it reaches the filesystem, or `resolve` collapses a `..` in it and the
// recursive delete lands on the backend's data directory.

let dir = "";
let db: Db;
let config: Config;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mania-replay-video-cancel-"));
  db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
  await migrate(db);
  config = { replayVideoWorkDir: join(dir, "replay-video-jobs") } as Config;
});

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("cancelReplayVideoExport", () => {
  it("removes the work dir for a well-formed id", async () => {
    const jobDir = join(config.replayVideoWorkDir, "aB3dE5f7");
    await mkdir(jobDir, { recursive: true });
    await writeFile(join(jobDir, "video.mp4"), "x");

    await cancelReplayVideoExport(db, config, "aB3dE5f7");

    expect(existsSync(jobDir)).toBe(false);
  });

  it("refuses an id that would escape the work dir", async () => {
    const sentinel = join(dir, "mania-hub-live.db");
    await writeFile(sentinel, "not a real db");
    await mkdir(config.replayVideoWorkDir, { recursive: true });

    for (const id of ["../..", "../../..", "..", "", "not-8-chars", "aB3dE5f7/../.."]) {
      await cancelReplayVideoExport(db, config, id);
    }

    expect(existsSync(sentinel)).toBe(true);
    expect(existsSync(config.replayVideoWorkDir)).toBe(true);
  });
});
