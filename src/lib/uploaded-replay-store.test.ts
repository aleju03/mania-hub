import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Force the local-disk branch regardless of what R2 vars the test shell has.
vi.mock("./r2-cache", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./r2-cache")>()),
  isR2ReplayCacheConfigured: () => false,
}));

import { listRecentUploadedReplays } from "./uploaded-replay-store";

describe("listRecentUploadedReplays", () => {
  let dir: string | null = null;

  afterEach(async () => {
    delete process.env.REPLAY_UPLOAD_DIR;
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = null;
  });

  it("returns newest-first ids, skipping metadata and malformed names", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "replay-uploads-"));
    process.env.REPLAY_UPLOAD_DIR = dir;

    const older = "a".repeat(20);
    const newer = "b".repeat(20);
    const newest = "c".repeat(20);
    for (const [name, ageSeconds] of [
      [`${older}.osr`, 300],
      [`${newer}.osr`, 200],
      [`${newest}.osr`, 100],
      // Sidecar metadata and a name too short to be a real upload id.
      [`${older}.json`, 100],
      ["short.osr", 100],
    ] as const) {
      const file = path.join(dir, name);
      await writeFile(file, "x");
      const mtime = new Date(Date.now() - ageSeconds * 1000);
      await utimes(file, mtime, mtime);
    }

    const all = await listRecentUploadedReplays(10);
    expect(all.map((entry) => entry.id)).toEqual([newest, newer, older]);
    expect(all[0]!.uploadedAt).toBeGreaterThan(all[2]!.uploadedAt);

    const capped = await listRecentUploadedReplays(2);
    expect(capped.map((entry) => entry.id)).toEqual([newest, newer]);
  });

  it("returns an empty list when the upload directory does not exist", async () => {
    process.env.REPLAY_UPLOAD_DIR = path.join(tmpdir(), "replay-uploads-missing-dir");
    expect(await listRecentUploadedReplays(5)).toEqual([]);
  });
});
