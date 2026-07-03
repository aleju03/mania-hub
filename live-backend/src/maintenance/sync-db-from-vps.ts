import { createClient } from "@libsql/client";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { access, chmod, copyFile, mkdir, mkdtemp, readdir, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { readConfig } from "../config.js";

interface Options {
  remote: string;
  remoteDir: string;
  remoteBackup: string | null;
  localDbPath: string | null;
  dryRun: boolean;
  force: boolean;
  includeLiveDb: boolean;
  keepDownload: boolean;
  quickCheck: boolean;
  backupLocal: boolean;
  fresh: boolean;
  compressSnapshot: boolean;
  keepRemoteSnapshots: number;
}

interface RemoteCandidate {
  modifiedAtMs: number;
  sizeBytes: number;
  path: string;
}

interface CommandResult {
  code: number;
  stdout: string;
}

const DEFAULT_REMOTE = "user@your-vps-host";
const DEFAULT_REMOTE_DIR = "~/apps/mania-hub/live-backend";
const DOWNLOAD_DIR_NAME = ".sync-from-vps";
const LOCAL_BACKUP_DIR_NAME = "local-db-backups";

const options = parseOptions(process.argv.slice(2));

if (options.dryRun) {
  console.log("Dry run: no local files will be changed.");
}

const localDbPath = resolveLocalDbPath(options);
const localSidecars = [localDbPath, `${localDbPath}-wal`, `${localDbPath}-shm`];

if (options.dryRun && options.fresh) {
  console.log(`Would create a fresh snapshot of the live DB on ${options.remote} (sqlite3 .backup${options.compressSnapshot ? " + zstd" : ""}), download it, and replace ${localDbPath}.`);
  console.log(`Would then prune remote online-* snapshots, keeping the newest ${options.keepRemoteSnapshots}.`);
  process.exit(0);
}

const remoteBackup = options.remoteBackup
  ? await resolveRemotePath(options.remote, options.remoteBackup)
  : options.fresh
    ? await createRemoteSnapshot(options)
    : await findLatestRemoteBackup(options);

console.log(`Remote: ${options.remote}`);
console.log(`Remote backup: ${remoteBackup.path} (${formatBytes(remoteBackup.sizeBytes)}, ${new Date(remoteBackup.modifiedAtMs).toISOString()})`);
console.log(`Local DB: ${localDbPath}`);

if (options.dryRun) {
  console.log("Run without --dry-run to download and replace the local DB.");
  process.exit(0);
}

await assertLocalDbNotOpen(localSidecars, options.force);

const downloadRoot = join(dirname(localDbPath), DOWNLOAD_DIR_NAME);
await mkdir(downloadRoot, { recursive: true });
await cleanupStaleRuns(downloadRoot);
const workDir = await mkdtemp(join(downloadRoot, "run-"));
const downloadedPath = join(workDir, basename(remoteBackup.path));
const preparedPath = join(workDir, "mania-hub-live.db");

try {
  console.log("Downloading remote backup...");
  await downloadRemoteFile(options.remote, remoteBackup.path, downloadedPath);
  const downloaded = await stat(downloadedPath);
  console.log(`Downloaded ${formatBytes(downloaded.size)}.`);

  await prepareDownloadedDatabase(downloadedPath, preparedPath);

  if (options.quickCheck) {
    console.log("Validating downloaded database with pragma quick_check...");
    await validateSqliteDatabase(preparedPath);
    console.log("SQLite quick_check passed.");
  }

  if (options.backupLocal) {
    const safetyBackupDir = await backupLocalDatabaseFiles(localSidecars);
    if (safetyBackupDir) {
      console.log(`Local safety backup: ${safetyBackupDir}`);
    } else {
      console.log("No existing local DB was found, so no safety backup was needed.");
    }
  }

  await replaceLocalDatabase(preparedPath, localDbPath);
  console.log("Local live-backend database updated.");

  if (options.fresh) {
    await pruneRemoteSnapshots(options);
  }

  if (!options.keepDownload) {
    await rm(workDir, { force: true, recursive: true });
  } else {
    console.log(`Kept downloaded files in ${workDir}`);
  }
} catch (error) {
  console.error(`Sync failed; keeping downloaded files in ${workDir} (cleaned up automatically on the next run).`);
  throw error;
}

function parseOptions(args: string[]): Options {
  const options: Options = {
    remote: process.env.LIVE_DB_SYNC_REMOTE || DEFAULT_REMOTE,
    remoteDir: process.env.LIVE_DB_SYNC_REMOTE_DIR || DEFAULT_REMOTE_DIR,
    remoteBackup: process.env.LIVE_DB_SYNC_REMOTE_BACKUP || null,
    localDbPath: process.env.LIVE_DB_SYNC_LOCAL_DB || null,
    dryRun: false,
    force: false,
    includeLiveDb: false,
    keepDownload: false,
    quickCheck: true,
    backupLocal: false,
    fresh: false,
    compressSnapshot: true,
    keepRemoteSnapshots: 2,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--remote":
        options.remote = readValue(args, ++index, arg);
        break;
      case "--remote-dir":
        options.remoteDir = readValue(args, ++index, arg);
        break;
      case "--remote-backup":
        options.remoteBackup = readValue(args, ++index, arg);
        break;
      case "--local-db":
        options.localDbPath = readValue(args, ++index, arg);
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--force":
        options.force = true;
        break;
      case "--include-live-db":
        options.includeLiveDb = true;
        break;
      case "--keep-download":
        options.keepDownload = true;
        break;
      case "--backup-local":
        options.backupLocal = true;
        break;
      case "--skip-quick-check":
        options.quickCheck = false;
        break;
      case "--fresh":
        options.fresh = true;
        break;
      case "--no-compress":
        options.compressSnapshot = false;
        break;
      case "--keep-remote": {
        const value = Number(readValue(args, ++index, arg));
        if (!Number.isInteger(value) || value < 1) {
          throw new Error("--keep-remote requires an integer >= 1.");
        }
        options.keepRemoteSnapshots = value;
        break;
      }
      case "--help":
      case "-h":
        printUsage();
        process.exit(0);
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
}

function readValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function printUsage(): void {
  console.log(`Usage:
  npm run db:sync-from-vps -- [options]

Options:
  --fresh                Create a fresh snapshot of the live DB on the VPS first (sqlite3 .backup),
                         then download that instead of the newest pre-existing backup. After a
                         successful sync, remote online-* snapshots are pruned (see --keep-remote).
  --no-compress          With --fresh, skip zstd compression of the remote snapshot.
  --keep-remote N        With --fresh, how many online-* snapshots to keep on the VPS. Default: 2.
  --dry-run              Show the remote backup that would be used.
  --remote USER@HOST     SSH target. Default: ${DEFAULT_REMOTE}
  --remote-dir PATH      Remote live-backend directory. Default: ${DEFAULT_REMOTE_DIR}
  --remote-backup PATH   Use an exact remote backup file instead of auto-discovery.
  --local-db PATH        Override the local DB path. Default: DATABASE_URL or data/mania-hub-live.db.
  --include-live-db      Allow using the remote data/mania-hub-live.db file if no backup is newer.
  --force                Replace even if lsof reports the local DB is open.
  --keep-download        Keep the downloaded backup in the temp sync folder.
  --backup-local         Copy current local DB files before replacing them.
  --skip-quick-check     Skip SQLite pragma quick_check validation.
`);
}

function resolveLocalDbPath(options: Options): string {
  if (options.localDbPath) return resolve(options.localDbPath);

  const config = readConfig();
  if (!config.databaseUrl.startsWith("file:")) {
    throw new Error(`DATABASE_URL must be a local file: URL for this sync utility. Got ${config.databaseUrl}`);
  }

  const rawPath = config.databaseUrl.slice("file:".length);
  return resolve(rawPath);
}

async function resolveRemotePath(remote: string, path: string): Promise<RemoteCandidate> {
  const command = [
    "set -eu",
    `path=${shellPath(path)}`,
    "[ -f \"$path\" ] || { echo \"Remote backup file not found: $path\" >&2; exit 2; }",
    "printf '%s\\t%s\\t%s\\n' \"$(stat -c %Y \"$path\")\" \"$(stat -c %s \"$path\")\" \"$path\"",
  ].join("\n");
  const result = await runCapture("ssh", [remote, command], [0]);
  const [modifiedAtSeconds, sizeBytes, remotePath] = result.stdout.trim().split("\t");
  return {
    modifiedAtMs: Number(modifiedAtSeconds) * 1000,
    sizeBytes: Number(sizeBytes),
    path: remotePath,
  };
}

async function createRemoteSnapshot(options: Options): Promise<RemoteCandidate> {
  const command = [
    "set -eu",
    `root=${shellPath(options.remoteDir)}`,
    "db=\"$root/data/mania-hub-live.db\"",
    "[ -f \"$db\" ] || { echo \"Remote live DB not found: $db\" >&2; exit 2; }",
    "command -v sqlite3 >/dev/null 2>&1 || { echo \"sqlite3 is required on the VPS to create a fresh snapshot.\" >&2; exit 2; }",
    "stamp=$(date -u +%Y%m%d-%H%M%S)",
    "dir=\"$root/data/backups/online-$stamp\"",
    "mkdir -p \"$dir\"",
    "out=\"$dir/mania-hub-live.db\"",
    "sqlite3 \"$db\" '.timeout 30000' \".backup '$out'\"",
    ...(options.compressSnapshot
      ? [
          "if command -v zstd >/dev/null 2>&1; then",
          "  zstd -q -3 --rm \"$out\"",
          "  out=\"$out.zst\"",
          "fi",
        ]
      : []),
    "printf '%s\\t%s\\t%s\\n' \"$(stat -c %Y \"$out\")\" \"$(stat -c %s \"$out\")\" \"$out\"",
  ].join("\n");

  console.log("Creating a fresh snapshot of the live DB on the VPS (sqlite3 .backup, safe while the backend is running)...");
  const result = await runCapture("ssh", [options.remote, command], [0]);
  const line = result.stdout.trim().split("\n").pop() ?? "";
  const [modifiedAtSeconds, sizeBytes, remotePath] = line.split("\t");
  if (!remotePath) {
    throw new Error("Failed to create the remote snapshot: unexpected output from the VPS.");
  }
  return {
    modifiedAtMs: Number(modifiedAtSeconds) * 1000,
    sizeBytes: Number(sizeBytes),
    path: remotePath,
  };
}

async function pruneRemoteSnapshots(options: Options): Promise<void> {
  const command = [
    "set -eu",
    `root=${shellPath(options.remoteDir)}`,
    "cd \"$root/data/backups\" 2>/dev/null || exit 0",
    "ls -1d online-* 2>/dev/null | sort -r | tail -n +" + (options.keepRemoteSnapshots + 1) + " | while read -r name; do",
    "  rm -rf -- \"./$name\"",
    "  echo \"$name\"",
    "done",
  ].join("\n");
  const result = await runCapture("ssh", [options.remote, command], [0]);
  const pruned = result.stdout.trim().split("\n").filter(Boolean);
  if (pruned.length > 0) {
    console.log(`Pruned ${pruned.length} old remote snapshot(s): ${pruned.join(", ")} (keeping the newest ${options.keepRemoteSnapshots}).`);
  }
}

async function findLatestRemoteBackup(options: Options): Promise<RemoteCandidate> {
  const command = [
    "set -eu",
    `root=${shellPath(options.remoteDir)}`,
    "[ -d \"$root\" ] || { echo \"Remote live-backend directory not found: $root\" >&2; exit 2; }",
    "find \"$root\" \\",
    "  \\( -path \"$root/node_modules\" -o -path \"$root/node_modules/*\" -o -path \"$root/dist\" -o -path \"$root/dist/*\" -o -path \"$root/data/replay-video-jobs\" -o -path \"$root/data/replay-video-jobs/*\" \\) -prune -o \\",
    "  -type f \\",
    "  \\( -name '*.db' -o -name '*.sqlite' -o -name '*.sqlite3' -o -name '*.db.gz' -o -name '*.sqlite.gz' -o -name '*.sqlite3.gz' -o -name '*.db.zst' -o -name '*.sqlite.zst' -o -name '*.sqlite3.zst' \\) \\",
    "  ! -name '*-wal' ! -name '*-shm' \\",
    "  -printf '%T@\\t%s\\t%p\\n'",
  ].join("\n");
  const result = await runCapture("ssh", [options.remote, command], [0]);
  const candidates = parseRemoteCandidates(result.stdout);
  const selectable = options.includeLiveDb
    ? candidates
    : candidates.filter((candidate) => !isRemoteLiveDb(candidate.path));

  if (selectable.length === 0) {
    const activeOnly = candidates.length > 0 && candidates.every((candidate) => isRemoteLiveDb(candidate.path));
    if (activeOnly) {
      throw new Error("Only the remote live DB file was found. Pass --include-live-db to allow using it, or pass --remote-backup PATH for a real backup file.");
    }
    throw new Error(`No DB backup candidates found under ${options.remoteDir}. Pass --remote-backup PATH if the backup uses a different name.`);
  }

  selectable.sort((a, b) => b.modifiedAtMs - a.modifiedAtMs);
  return selectable[0];
}

function parseRemoteCandidates(output: string): RemoteCandidate[] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [modifiedAt, sizeBytes, path] = line.split("\t");
      return {
        modifiedAtMs: Number(modifiedAt) * 1000,
        sizeBytes: Number(sizeBytes),
        path,
      };
    })
    .filter((candidate) => Number.isFinite(candidate.modifiedAtMs) && Number.isFinite(candidate.sizeBytes) && Boolean(candidate.path));
}

function isRemoteLiveDb(path: string): boolean {
  return /\/data\/mania-hub-live\.db$/.test(path);
}

async function assertLocalDbNotOpen(paths: string[], force: boolean): Promise<void> {
  const existing = [];
  for (const path of paths) {
    if (await exists(path)) existing.push(path);
  }
  if (existing.length === 0) return;
  if (!await commandExists("lsof")) {
    console.log("lsof is not available, so open-file detection was skipped. Stop the local backend before syncing.");
    return;
  }

  const result = await runCapture("lsof", ["--", ...existing], [0, 1]);
  if (result.code === 1 || result.stdout.trim() === "") return;
  if (force) {
    console.log("lsof reports the local DB is open, but --force was passed.");
    return;
  }

  throw new Error(`The local DB appears to be open by another process:
${result.stdout.trim()}

Stop the local live backend first, or rerun with --force if you are certain it is safe.`);
}

async function cleanupStaleRuns(downloadRoot: string): Promise<void> {
  const entries = await readdir(downloadRoot).catch(() => [] as string[]);
  for (const entry of entries) {
    if (entry.startsWith("run-")) {
      await rm(join(downloadRoot, entry), { force: true, recursive: true }).catch(() => undefined);
    }
  }
}

async function commandExists(command: string): Promise<boolean> {
  // dash (Ubuntu /bin/sh) exits 127 for a missing command, bash exits 1.
  const result = await runCapture("sh", ["-c", `command -v ${shellQuote(command)} >/dev/null 2>&1`], [0, 1, 126, 127]);
  return result.code === 0;
}

async function downloadRemoteFile(remote: string, remotePath: string, localPath: string): Promise<void> {
  await runInherit("scp", ["-p", `${remote}:${remotePath}`, localPath]);
}

async function prepareDownloadedDatabase(downloadedPath: string, preparedPath: string): Promise<void> {
  if (downloadedPath.endsWith(".gz")) {
    if (!await commandExists("gzip")) throw new Error("gzip is required to unpack this backup.");
    await streamCommandToFile("gzip", ["-dc", downloadedPath], preparedPath);
  } else if (downloadedPath.endsWith(".zst")) {
    if (!await commandExists("zstd")) throw new Error("zstd is required to unpack this backup.");
    await streamCommandToFile("zstd", ["-dc", downloadedPath], preparedPath);
  } else if (downloadedPath !== preparedPath) {
    await copyFile(downloadedPath, preparedPath);
  } else {
    // Already downloaded to the final temp DB path.
  }
  await chmod(preparedPath, 0o600);
}

async function streamCommandToFile(command: string, args: string[], outputPath: string): Promise<void> {
  const child = spawn(command, args, {
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (!child.stdout) throw new Error(`Failed to read stdout from ${command}.`);
  // Attach the exit listener before awaiting the stream: if the process has
  // already exited by the time we start waiting, the close event never fires
  // again and the promise would hang forever (silent "unsettled top-level await").
  const exitCode = waitForExit(child);
  await pipeline(child.stdout, createWriteStream(outputPath, { mode: 0o600 }));
  const code = await exitCode;
  if (code !== 0) throw new Error(`${command} exited with code ${code}.`);
}

async function validateSqliteDatabase(path: string): Promise<void> {
  const client = createClient({ url: `file:${path}` });
  try {
    const result = await client.execute("pragma quick_check");
    const messages = result.rows.map((row) => String(Object.values(row)[0] ?? "")).filter(Boolean);
    if (messages.length === 0 || messages.some((message) => message.toLowerCase() !== "ok")) {
      throw new Error(`SQLite quick_check failed: ${messages.join("; ") || "no result"}`);
    }
    await client.execute("select count(*) as table_count from sqlite_master");
  } finally {
    client.close();
    await rm(`${path}-wal`, { force: true }).catch(() => undefined);
    await rm(`${path}-shm`, { force: true }).catch(() => undefined);
  }
}

async function backupLocalDatabaseFiles(paths: string[]): Promise<string | null> {
  const existing = [];
  for (const path of paths) {
    if (await exists(path)) existing.push(path);
  }
  if (existing.length === 0) return null;

  const backupDir = join(dirname(paths[0]), LOCAL_BACKUP_DIR_NAME, timestampForPath(new Date()));
  await mkdir(backupDir, { recursive: true });
  for (const path of existing) {
    await copyFile(path, join(backupDir, basename(path)));
  }
  return backupDir;
}

async function replaceLocalDatabase(preparedPath: string, localDbPath: string): Promise<void> {
  await mkdir(dirname(localDbPath), { recursive: true });
  await rm(`${localDbPath}-wal`, { force: true });
  await rm(`${localDbPath}-shm`, { force: true });
  await rm(localDbPath, { force: true });
  await rename(preparedPath, localDbPath);
  await chmod(localDbPath, 0o600);
}

function timestampForPath(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "unknown size";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function runCapture(command: string, args: string[], allowedCodes: number[]): Promise<CommandResult> {
  const child = spawn(command, args, {
    stdio: ["inherit", "pipe", "inherit"],
  });
  const chunks: Buffer[] = [];
  child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
  const code = await waitForExit(child);
  if (!allowedCodes.includes(code)) {
    throw new Error(`${command} ${args.join(" ")} exited with code ${code}.`);
  }
  return { code, stdout: Buffer.concat(chunks).toString("utf8") };
}

async function runInherit(command: string, args: string[]): Promise<void> {
  const child = spawn(command, args, {
    stdio: "inherit",
  });
  const code = await waitForExit(child);
  if (code !== 0) throw new Error(`${command} ${args.join(" ")} exited with code ${code}.`);
}

function waitForExit(child: ReturnType<typeof spawn>): Promise<number> {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(child.exitCode ?? 1);
      return;
    }
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
}

function shellPath(path: string): string {
  if (path === "~") return "$HOME";
  if (path.startsWith("~/")) return `$HOME/${shellQuote(path.slice(2))}`;
  return shellQuote(path);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
