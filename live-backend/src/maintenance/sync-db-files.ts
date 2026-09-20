import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { rm, statfs } from "node:fs/promises";
import { pipeline } from "node:stream/promises";

export function sqliteSizeFromHeader(header: Buffer): number {
  if (header.length !== 100 || header.subarray(0, 16).toString("binary") !== "SQLite format 3\0") {
    throw new Error("Backup does not contain a valid SQLite header.");
  }
  const encodedPageSize = header.readUInt16BE(16);
  const pageSize = encodedPageSize === 1 ? 65536 : encodedPageSize;
  const pages = header.readUInt32BE(28);
  if (pageSize < 512 || pageSize > 65536 || (pageSize & (pageSize - 1)) !== 0 || pages === 0
    || header.readUInt32BE(24) !== header.readUInt32BE(92)) {
    throw new Error("Cannot determine the unpacked SQLite size reliably; create a fresh snapshot.");
  }
  return pages * pageSize;
}

export function requiredSyncSpace(downloadBytes: number, unpackedBytes: number, backupBytes: number): number {
  const peak = downloadBytes + unpackedBytes + backupBytes;
  return peak + Math.max(1024 ** 3, Math.ceil(peak * 0.1));
}

export async function assertSyncSpace(directory: string, requiredBytes: number): Promise<void> {
  const fs = await statfs(directory);
  const available = fs.bavail * fs.bsize;
  if (available < requiredBytes) {
    const gib = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
    throw new Error(`Not enough local disk space under ${directory}: ${gib(available)} available, need ${gib(requiredBytes)} including unpacking, any safety backup, and headroom. Free space before retrying.`);
  }
}

export async function streamCommandToFile(command: string, args: string[], outputPath: string): Promise<void> {
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "inherit"] });
  // Observe both errors immediately: a missing executable and a failed writer
  // must never leave an unhandled rejection or a decompressor running behind us.
  const exit = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with code ${code}.`)));
  });
  const writing = pipeline(child.stdout!, createWriteStream(outputPath, { mode: 0o600 }));
  try {
    await Promise.all([writing, exit]);
  } catch (error) {
    child.kill("SIGKILL");
    await Promise.allSettled([writing, exit]);
    await rm(outputPath, { force: true });
    throw error;
  }
}
