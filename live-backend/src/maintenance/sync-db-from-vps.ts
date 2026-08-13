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
  analyticsLocalDbPath: string | null;
  withAnalytics: boolean;
  analyticsOnly: boolean;
  dryRun: boolean;
  force: boolean;
  includeLiveDb: boolean;
  keepDownload: boolean;
  quickCheck: boolean;
  backupLocal: boolean;
  fresh: boolean;
  compressSnapshot: boolean;
  keepRemoteSnapshots: number;
  keepLocalBackups: number;
}

// The analytics DB is a second SQLite file with its own WAL (ANALYTICS_DATABASE_URL),
// so it is synced as a separate target rather than as a sidecar of the live DB.
type TargetKey = "live" | "analytics";

interface SyncTarget {
  key: TargetKey;
  label: string;
  // Relative to the remote live-backend directory.
  remoteRelativePath: string;
  fileName: string;
  localDbPath: string;
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

// Real target lives in live-backend/.env as LIVE_DB_SYNC_REMOTE (gitignored); keep no real host here.
const DEFAULT_REMOTE = "user@your-vps-host";
const DEFAULT_REMOTE_DIR = "~/apps/mania-hub/live-backend";
const DOWNLOAD_DIR_NAME = ".sync-from-vps";
const LOCAL_BACKUP_DIR_NAME = "local-db-backups";
const REMOTE_LIVE_DB = "data/mania-hub-live.db";
const REMOTE_ANALYTICS_DB = "data/mania-hub-analytics.db";

// Declared before the top-level flow below, which reaches it through buildTargets().
let cachedConfig: ReturnType<typeof readConfig> | null = null;

const options = parseOptions(process.argv.slice(2));

if (options.dryRun) {
  console.log("Dry run: no local files will be changed.");
}

const targets = buildTargets(options);
const localSidecars = targets.flatMap(sidecarsFor);

if (options.dryRun && options.fresh) {
  console.log(`Would prune remote online-* snapshots down to ${Math.max(0, options.keepRemoteSnapshots - 1)}, then create a fresh snapshot on ${options.remote} (sqlite3 VACUUM INTO${options.compressSnapshot ? " + zstd" : ""}) of:`);
  for (const target of targets) {
    console.log(`  ${target.label}: ${options.remoteDir}/${target.remoteRelativePath} -> ${target.localDbPath}`);
  }
  console.log(`Would end with the newest ${options.keepRemoteSnapshots} remote snapshot(s)${options.backupLocal ? ` and the newest ${options.keepLocalBackups} local backup(s)` : ""}.`);
  process.exit(0);
}

const remoteBackups = await resolveRemoteBackups(options, targets);

console.log(`Remote: ${options.remote}`);
for (const target of targets) {
  const remoteBackup = remoteBackups.get(target.key)!;
  console.log(`Remote ${target.label} backup: ${remoteBackup.path} (${formatBytes(remoteBackup.sizeBytes)}, ${new Date(remoteBackup.modifiedAtMs).toISOString()})`);
  console.log(`Local ${target.label}: ${target.localDbPath}`);
}

if (options.dryRun) {
  console.log(`Run without --dry-run to download and replace the local ${targets.length > 1 ? "databases" : "database"}.`);
  process.exit(0);
}

await assertLocalDbNotOpen(localSidecars, options.force);

const downloadRoot = join(dirname(targets[0].localDbPath), DOWNLOAD_DIR_NAME);
await mkdir(downloadRoot, { recursive: true });
await cleanupStaleRuns(downloadRoot);
const workDir = await mkdtemp(join(downloadRoot, "run-"));
// One stamp for the whole run, so syncing both DBs leaves one backup folder
// holding both instead of burning two slots of --keep-local.
const backupStamp = timestampForPath(new Date());

try {
  for (const target of targets) {
    const remoteBackup = remoteBackups.get(target.key)!;
    const downloadedPath = join(workDir, basename(remoteBackup.path));
    const preparedPath = join(workDir, `prepared-${target.key}.db`);

    console.log(`Downloading remote ${target.label} backup...`);
    await downloadRemoteFile(options.remote, remoteBackup.path, downloadedPath);
    const downloaded = await stat(downloadedPath);
    console.log(`Downloaded ${formatBytes(downloaded.size)}.`);

    await prepareDownloadedDatabase(downloadedPath, preparedPath);

    if (options.quickCheck) {
      console.log(`Validating downloaded ${target.label} with pragma quick_check...`);
      await validateSqliteDatabase(preparedPath);
      console.log("SQLite quick_check passed.");
    }

    if (options.backupLocal) {
      const safetyBackupDir = await backupLocalDatabaseFiles(sidecarsFor(target), backupStamp);
      if (safetyBackupDir) {
        console.log(`Local safety backup: ${safetyBackupDir}`);
      } else {
        console.log(`No existing local ${target.label} was found, so no safety backup was needed.`);
      }
    }

    await replaceLocalDatabase(preparedPath, target.localDbPath);
    console.log(`Local ${target.label} updated.`);
  }

  // Each safety backup is a full copy of a multi-GB database, so retention is
  // enforced the moment a new one lands rather than left to the operator.
  if (options.backupLocal) {
    await pruneLocalBackups(targets[0].localDbPath, options.keepLocalBackups);
  }

  if (options.fresh) {
    // The pre-snapshot prune already made room; this is the idempotent backstop
    // that drops the snapshot we just superseded.
    await pruneRemoteSnapshots(options, options.keepRemoteSnapshots);
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
    analyticsLocalDbPath: process.env.LIVE_DB_SYNC_LOCAL_ANALYTICS_DB || null,
    withAnalytics: false,
    analyticsOnly: false,
    dryRun: false,
    force: false,
    includeLiveDb: false,
    keepDownload: false,
    quickCheck: true,
    backupLocal: false,
    fresh: false,
    compressSnapshot: true,
    keepRemoteSnapshots: 2,
    keepLocalBackups: 2,
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
      case "--analytics-local-db":
        options.analyticsLocalDbPath = readValue(args, ++index, arg);
        break;
      case "--with-analytics":
        options.withAnalytics = true;
        break;
      case "--analytics-only":
        options.analyticsOnly = true;
        options.withAnalytics = true;
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
      case "--keep-local": {
        const value = Number(readValue(args, ++index, arg));
        if (!Number.isInteger(value) || value < 1) {
          throw new Error("--keep-local requires an integer >= 1.");
        }
        options.keepLocalBackups = value;
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
  --with-analytics       Also sync the analytics DB (ANALYTICS_DATABASE_URL, a separate SQLite file on
                         the VPS). With --fresh both databases are snapshotted into the same
                         online-* directory; otherwise the newest backup of each is downloaded.
  --analytics-only       Sync only the analytics DB and leave the local live DB alone. With --fresh
                         this still counts as a snapshot run, so it can prune an older online-*
                         directory that held a live DB snapshot (--keep-remote applies to runs, not
                         to databases); a later live sync then needs --fresh of its own.
  --analytics-local-db PATH
                         Override the local analytics DB path. Default: ANALYTICS_DATABASE_URL or
                         data/mania-hub-analytics.db.
  --fresh                Create a fresh snapshot of the live DB on the VPS first (sqlite3 VACUUM INTO,
                         which stays consistent while the backend writes and compacts free pages),
                         then download that instead of the newest pre-existing backup. Older
                         online-* snapshots are pruned before the new one is created, so a run that
                         fails cannot leave them piling up (see --keep-remote).
  --no-compress          With --fresh, skip zstd compression of the remote snapshot.
  --keep-remote N        With --fresh, how many online-* snapshots to keep on the VPS. Default: 2.
  --dry-run              Show the remote backup that would be used.
  --remote USER@HOST     SSH target. Default: ${DEFAULT_REMOTE}
  --remote-dir PATH      Remote live-backend directory. Default: ${DEFAULT_REMOTE_DIR}
  --remote-backup PATH   Use an exact remote backup file instead of auto-discovery. Applies to the
                         live DB when both databases are synced.
  --local-db PATH        Override the local DB path. Default: DATABASE_URL or data/mania-hub-live.db.
  --include-live-db      Allow using a live database file itself (data/mania-hub-live.db,
                         data/mania-hub-analytics.db) when no backup of it exists. Note that copying
                         a live file leaves its WAL behind, so prefer --fresh.
  --force                Replace even if lsof reports the local DB is open.
  --keep-download        Keep the downloaded backup in the temp sync folder.
  --backup-local         Copy current local DB files before replacing them.
  --keep-local N         With --backup-local, how many local backup folders to keep. Default: 2.
  --skip-quick-check     Skip SQLite pragma quick_check validation.
`);
}

function buildTargets(options: Options): SyncTarget[] {
  const targets: SyncTarget[] = [];
  if (!options.analyticsOnly) {
    targets.push({
      key: "live",
      label: "live DB",
      remoteRelativePath: REMOTE_LIVE_DB,
      fileName: basename(REMOTE_LIVE_DB),
      localDbPath: resolveLocalDbPath(options.localDbPath, "databaseUrl", "DATABASE_URL"),
    });
  }
  if (options.withAnalytics) {
    targets.push({
      key: "analytics",
      label: "analytics DB",
      remoteRelativePath: REMOTE_ANALYTICS_DB,
      fileName: basename(REMOTE_ANALYTICS_DB),
      localDbPath: resolveLocalDbPath(options.analyticsLocalDbPath, "analyticsDatabaseUrl", "ANALYTICS_DATABASE_URL"),
    });
  }
  return targets;
}

function sidecarsFor(target: SyncTarget): string[] {
  return [target.localDbPath, `${target.localDbPath}-wal`, `${target.localDbPath}-shm`];
}

// Read lazily and once: an explicit --local-db / --analytics-local-db should not
// need a loadable config, and two targets should not parse the env twice.
function resolveLocalDbPath(
  override: string | null,
  configKey: "databaseUrl" | "analyticsDatabaseUrl",
  envName: string,
): string {
  if (override) return resolve(override);

  cachedConfig ??= readConfig();
  const databaseUrl = cachedConfig[configKey];
  if (!databaseUrl.startsWith("file:")) {
    throw new Error(`${envName} must be a local file: URL for this sync utility. Got ${databaseUrl}`);
  }

  const rawPath = databaseUrl.slice("file:".length);
  if (!rawPath || rawPath === ":memory:") {
    throw new Error(`${envName} must point at a database file for this sync utility. Got ${databaseUrl}`);
  }
  return resolve(rawPath);
}

// --remote-backup pins one file, and with a single target that is unambiguous.
// With both targets it pins the live DB (the one it has always meant) and the
// analytics DB still goes through snapshot/discovery.
async function resolveRemoteBackups(options: Options, targets: SyncTarget[]): Promise<Map<TargetKey, RemoteCandidate>> {
  const resolved = new Map<TargetKey, RemoteCandidate>();
  if (options.remoteBackup) {
    const pinned = targets.find((target) => target.key === "live") ?? targets[0];
    resolved.set(pinned.key, await resolveRemotePath(options.remote, options.remoteBackup));
  }

  const remaining = targets.filter((target) => !resolved.has(target.key));
  if (remaining.length === 0) return resolved;

  const discovered = options.fresh
    ? await createFreshRemoteSnapshot(options, remaining)
    : await findLatestRemoteBackups(options, remaining);
  for (const [key, candidate] of discovered) resolved.set(key, candidate);
  return resolved;
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

// Prune before the snapshot, not after the sync: the old code only pruned once
// the download had been validated and installed, so every failed run left a
// full-size online-* dir behind and N failures meant N snapshots on a disk that
// has room for about two. Freeing first also gives the VACUUM the space it
// needs instead of making it compete with the copies it is about to replace.
async function createFreshRemoteSnapshot(options: Options, targets: SyncTarget[]): Promise<Map<TargetKey, RemoteCandidate>> {
  await pruneRemoteSnapshots(options, Math.max(0, options.keepRemoteSnapshots - 1));
  return createRemoteSnapshot(options, targets);
}

// Every target of a run is snapshotted into the same online-<stamp> directory, so
// the whole-directory prune keeps working untouched and a run is all-or-nothing.
async function createRemoteSnapshot(options: Options, targets: SyncTarget[]): Promise<Map<TargetKey, RemoteCandidate>> {
  const command = [
    "set -eu",
    `root=${shellPath(options.remoteDir)}`,
    "command -v sqlite3 >/dev/null 2>&1 || { echo \"sqlite3 is required on the VPS to create a fresh snapshot.\" >&2; exit 2; }",
    ...targets.flatMap((target, index) => [
      `db${index}="$root"/${shellQuote(target.remoteRelativePath)}`,
      `[ -f "$db${index}" ] || { echo "Remote ${target.label} not found: $db${index}" >&2; exit 2; }`,
    ]),
    // VACUUM INTO writes a second full copy of the DB, and zstd --rm briefly
    // holds the plain copy and the .zst at once. Failing here is a clean abort;
    // filling the VPS disk mid-snapshot takes the live backend down with it.
    "need=0",
    ...targets.map((_, index) => `need=$((need + $(stat -c %s "$db${index}")))`),
    "need=$((need + need / 10))",
    "avail=$(df -Pk \"$(dirname \"$db0\")\" 2>/dev/null | awk 'NR==2{print $4}')",
    "if [ -n \"$avail\" ] && [ \"$((avail * 1024))\" -lt \"$need\" ]; then",
    "  echo \"Not enough free space on the VPS for a snapshot: $((avail / 1024)) MiB available under $(dirname \"$db0\"), need about $((need / 1048576)) MiB.\" >&2",
    "  exit 2",
    "fi",
    "stamp=$(date -u +%Y%m%d-%H%M%S)",
    "dir=\"$root/data/backups/online-$stamp\"",
    "mkdir -p \"$dir\"",
    // If anything below fails (or the SSH session dies), remove the partial
    // snapshot dir so a later non-fresh sync can never pick up a truncated DB.
    "trap 'rm -rf \"$dir\"' EXIT",
    ...targets.flatMap((target, index) => [
      `out="$dir"/${shellQuote(target.fileName)}`,
      // VACUUM INTO copies from a single read transaction, so unlike .backup it
      // never restarts when the live backend writes mid-copy (which made large
      // snapshots spin forever). It also compacts free pages. The timeout is a
      // hard stop so a wedged snapshot fails loudly instead of hanging the sync.
      `timeout 1800 sqlite3 "$db${index}" '.timeout 30000' "VACUUM INTO '$out.tmp'"`,
      "mv \"$out.tmp\" \"$out\"",
      ...(options.compressSnapshot
        ? [
            "if command -v zstd >/dev/null 2>&1; then",
            "  zstd -q -3 --rm \"$out\"",
            "  out=\"$out.zst\"",
            "fi",
          ]
        : []),
      `printf '%s\\t%s\\t%s\\t%s\\n' ${shellQuote(target.key)} "$(stat -c %Y "$out")" "$(stat -c %s "$out")" "$out"`,
    ]),
    "trap - EXIT",
  ].join("\n");

  console.log(`Creating a fresh snapshot on the VPS of the ${targets.map((target) => target.label).join(" and ")} (sqlite3 VACUUM INTO, consistent even while the backend writes)...`);
  const result = await runCapture("ssh", [options.remote, command], [0]);
  const snapshots = new Map<TargetKey, RemoteCandidate>();
  for (const line of result.stdout.split("\n")) {
    const [key, modifiedAtSeconds, sizeBytes, remotePath] = line.trim().split("\t");
    const target = targets.find((candidate) => candidate.key === key);
    if (!target || !remotePath) continue;
    snapshots.set(target.key, {
      modifiedAtMs: Number(modifiedAtSeconds) * 1000,
      sizeBytes: Number(sizeBytes),
      path: remotePath,
    });
  }

  const missing = targets.filter((target) => !snapshots.has(target.key));
  if (missing.length > 0) {
    throw new Error(`Failed to create the remote snapshot: the VPS reported no file for the ${missing.map((target) => target.label).join(", ")}.`);
  }
  return snapshots;
}

async function pruneRemoteSnapshots(options: Options, keep: number): Promise<void> {
  const command = [
    "set -eu",
    `root=${shellPath(options.remoteDir)}`,
    "cd \"$root/data/backups\" 2>/dev/null || exit 0",
    "ls -1d online-* 2>/dev/null | sort -r | tail -n +" + (keep + 1) + " | while read -r name; do",
    "  rm -rf -- \"./$name\"",
    "  echo \"$name\"",
    "done",
  ].join("\n");
  const result = await runCapture("ssh", [options.remote, command], [0]);
  const pruned = result.stdout.trim().split("\n").filter(Boolean);
  if (pruned.length > 0) {
    console.log(`Pruned ${pruned.length} old remote snapshot(s): ${pruned.join(", ")} (keeping the newest ${keep}).`);
  }
}

async function pruneLocalBackups(localDbPath: string, keep: number): Promise<void> {
  const root = join(dirname(localDbPath), LOCAL_BACKUP_DIR_NAME);
  const entries = await readdir(root, { withFileTypes: true }).catch(() => null);
  if (!entries) return;
  // The directory names are ISO timestamps with the colons swapped out, so
  // lexicographic order is chronological order.
  const dirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  const stale = dirs.slice(0, Math.max(0, dirs.length - keep));
  for (const name of stale) {
    await rm(join(root, name), { force: true, recursive: true }).catch(() => undefined);
  }
  if (stale.length > 0) {
    console.log(`Pruned ${stale.length} old local backup(s) from ${root} (keeping the newest ${keep}).`);
  }
}

async function findLatestRemoteBackups(options: Options, targets: SyncTarget[]): Promise<Map<TargetKey, RemoteCandidate>> {
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
  const backups = new Map<TargetKey, RemoteCandidate>();

  for (const target of targets) {
    // Match by file name, not just "newest .db under the remote dir": the two
    // databases live side by side, and the analytics file (written constantly,
    // so always the newest) would otherwise be installed over the live DB.
    const matching = candidates.filter((candidate) => matchesTarget(candidate.path, target));
    const selectable = options.includeLiveDb
      ? matching
      : matching.filter((candidate) => !isRemoteActiveDb(candidate.path, target));

    if (selectable.length === 0) {
      const activeOnly = matching.length > 0;
      if (activeOnly) {
        throw new Error(`Only the remote ${target.label} file itself was found, with no backup of it. Pass --include-live-db to allow using the live file, or pass --remote-backup PATH for a real backup file.`);
      }
      throw new Error(`No ${target.label} backup candidates (${target.fileName}) found under ${options.remoteDir}. Pass --remote-backup PATH if the backup uses a different name, or --fresh to create one.`);
    }

    selectable.sort((a, b) => b.modifiedAtMs - a.modifiedAtMs);
    backups.set(target.key, selectable[0]);
  }

  return backups;
}

function matchesTarget(path: string, target: SyncTarget): boolean {
  const name = basename(path).replace(/\.(gz|zst)$/i, "");
  if (name === target.fileName) return true;
  // Tolerate a stamped variant of the same database (mania-hub-live-2026....db),
  // which cannot collide across targets because the stems differ.
  const stem = target.fileName.replace(/\.(db|sqlite3|sqlite)$/i, "");
  return new RegExp(`^${escapeRegExp(stem)}[-_.].*\\.(db|sqlite3|sqlite)$`, "i").test(name);
}

function isRemoteActiveDb(path: string, target: SyncTarget): boolean {
  return path.endsWith(`/${target.remoteRelativePath}`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

async function backupLocalDatabaseFiles(paths: string[], stamp: string): Promise<string | null> {
  const existing = [];
  for (const path of paths) {
    if (await exists(path)) existing.push(path);
  }
  if (existing.length === 0) return null;

  const backupDir = join(dirname(paths[0]), LOCAL_BACKUP_DIR_NAME, stamp);
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
