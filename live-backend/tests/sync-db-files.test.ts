import { createClient } from "@libsql/client";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { assertSyncSpace, requiredSyncSpace, sqliteSizeFromHeader, streamCommandToFile } from "../src/maintenance/sync-db-files.js";

const run = promisify(execFile);
const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mania-sync-test-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("database sync storage safety", () => {
  it("accounts for archives, expanded output, safety copies and headroom", async () => {
    const gib = 1024 ** 3;
    expect(requiredSyncSpace(6 * gib, 14 * gib, 10 * gib)).toBe(33 * gib);
    expect(requiredSyncSpace(0, 14 * gib, 0)).toBe(14 * gib + Math.ceil(1.4 * gib));
    await expect(assertSyncSpace(await tempDir(), Number.MAX_SAFE_INTEGER)).rejects.toThrow("Not enough local disk space");
  });

  it("reads database sizes above 4 GiB and refuses unreliable headers", () => {
    const header = Buffer.alloc(100);
    header.write("SQLite format 3\0", "binary");
    header.writeUInt16BE(4096, 16);
    header.writeUInt32BE(4_000_000, 28);
    expect(sqliteSizeFromHeader(header)).toBe(16_384_000_000);
    header.writeUInt16BE(1, 16);
    expect(sqliteSizeFromHeader(header)).toBe(262_144_000_000);
    header.writeUInt32BE(1, 24);
    expect(() => sqliteSizeFromHeader(header)).toThrow("reliably");
    expect(() => sqliteSizeFromHeader(Buffer.alloc(10))).toThrow("valid SQLite header");
  });

  it("removes partial output when the decoder exits unsuccessfully", async () => {
    const output = join(await tempDir(), "partial.db");
    await expect(streamCommandToFile(process.execPath, ["-e", "process.stdout.write('partial'); process.exitCode = 2"], output)).rejects.toThrow("exited with code 2");
    await expect(stat(output)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("handles spawn and writer errors without leaving a child running", async () => {
    const dir = await tempDir();
    const output = join(dir, "partial.db");
    await expect(streamCommandToFile(join(dir, "missing-decoder"), [], output)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(output)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(streamCommandToFile(process.execPath, ["-e", "setInterval(() => process.stdout.write('data'), 1)"], join(dir, "missing", "out"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.skipIf(process.platform !== "linux")("reports ENOSPC and removes the failed output", async () => {
    const output = join(await tempDir(), "full.db");
    await symlink("/dev/full", output);
    await expect(streamCommandToFile(process.execPath, ["-e", "setInterval(() => process.stdout.write('data'), 1)"], output)).rejects.toMatchObject({ code: "ENOSPC" });
    await expect(stat(output)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses an oversized remote snapshot before scp and leaves the local DB intact", async () => {
    const dir = await tempDir();
    const bin = join(dir, "bin");
    await mkdir(bin);
    await writeFile(join(bin, "ssh"), '#!/bin/sh\nshift\nexec sh -c "$1"\n', { mode: 0o700 });
    const marker = join(dir, "scp-called");
    await writeFile(join(bin, "scp"), `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, { mode: 0o700 });
    const header = Buffer.alloc(100);
    header.write("SQLite format 3\0", "binary");
    header.writeUInt16BE(1, 16);
    header.writeUInt32BE(0xffffffff, 28);
    const remote = join(dir, "remote.db");
    const destination = join(dir, "local.db");
    await writeFile(remote, header);
    await writeFile(destination, "original");
    const error = await run(process.execPath, ["--import", "tsx", resolve("src/maintenance/sync-db-from-vps.ts"), "--remote-backup", remote, "--local-db", destination, "--remote", "fake"], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    }).catch((error: unknown) => error);
    expect(error).toMatchObject({ code: 1, stderr: expect.stringContaining("Not enough local disk space") });
    expect(await readFile(destination, "utf8")).toBe("original");
    await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("recovers a retained gzip archive without remote access or deleting its source run", async () => {
    const dir = await tempDir();
    const original = join(dir, "original.db");
    const db = createClient({ url: `file:${original}` });
    await db.execute("create table evidence (value text)");
    await db.execute("insert into evidence values ('retained')");
    db.close();
    await mkdir(join(dir, ".sync-from-vps"));
    const runDir = await mkdtemp(join(dir, ".sync-from-vps", "run-source-"));
    const archive = join(runDir, "live.db.gz");
    await writeFile(archive, gzipSync(await readFile(original)));
    const destination = join(dir, "restored.db");
    const { stdout } = await run(process.execPath, ["--import", "tsx", resolve("src/maintenance/sync-db-from-vps.ts"), "--from-download", archive, "--local-db", destination, "--remote", "must-not-contact.invalid"], {
      env: { ...process.env, LIVE_DB_SYNC_REMOTE_BACKUP: "" },
    });
    expect(stdout).toContain("SQLite quick_check passed");
    expect(await readFile(destination)).toEqual(await readFile(original));
    expect((await stat(archive)).size).toBeGreaterThan(0);
  });
});
