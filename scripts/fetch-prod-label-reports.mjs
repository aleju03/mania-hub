import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, parseEnv } from "node:util";

// Exports production chart label reports (players saying a chart is filed
// wrong, backend features/chart-label-reports.ts) into local-notes/ for
// classifier, vibro and eligibility tuning. Read-only: the backend's admin
// export endpoint is called on the VPS over SSH, like bugs:pull. Each row names
// its reporter with their rating and whether they played it.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Runs on the VPS, sent over SSH stdin.
async function remoteExport() {
  const { readFile } = await import("node:fs/promises");
  const { parseEnv } = await import("node:util");
  const backend = parseEnv(await readFile(".env", "utf8"));
  const token = backend.LIVE_ADMIN_TOKEN;
  if (!token) throw new Error("Production backend/.env has no LIVE_ADMIN_TOKEN.");
  const response = await fetch(`http://127.0.0.1:${Number(backend.PORT || 7227)}/api/admin/chart-label-reports/export`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`Label reports API returned HTTP ${response.status}.`);
  process.stdout.write(JSON.stringify(await response.json()));
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function fetchRemote(remote, remoteDir) {
  if (remote.startsWith("-") || /[\s\0]/.test(remote)) throw new Error("Invalid SSH target.");
  const path = remoteDir.startsWith("~/") ? `"$HOME"/${shellQuote(remoteDir.slice(2))}` : shellQuote(remoteDir);
  const source = `(${remoteExport.toString()})().catch((error) => { console.error(error.message); process.exitCode = 1; });`;
  return new Promise((done, reject) => {
    const child = spawn("ssh", ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", remote,
      `cd ${path} && node --input-type=module`], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Production export timed out after two minutes.")); }, 120_000);
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => { clearTimeout(timeout); reject(error); });
    child.stdin.on("error", () => {});
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) return reject(new Error(`SSH export failed (${code}): ${stderr.trim()}`));
      try { done(JSON.parse(stdout)); } catch { reject(new Error("Production returned invalid JSON.")); }
    });
    child.stdin.end(source);
  });
}

const CSV_COLUMNS = [
  "beatmapId", "keyCount", "rate", "status", "filedLabel", "filedFamily", "filedRawDan", "filedTiles", "filedVibro",
  "analysisVersion", "currentLabel", "currentTiles", "suggestedTile", "suggestedFamily", "suggestedLevel", "suggestedTier", "suggestedRawDan",
  "rateable", "rateableReasons", "username", "userId", "played", "reporterOverall", "note", "title", "version", "createdAt",
];

function csvCell(value) {
  if (value == null) return "";
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function toCsv(reports) {
  const rows = reports.map((report) => ({
    beatmapId: report.beatmapId,
    keyCount: report.keyCount,
    rate: report.rate,
    status: report.status,
    filedLabel: report.filed?.label,
    filedFamily: report.filed?.family,
    filedRawDan: report.filed?.rawDan,
    filedTiles: report.filed?.tiles?.join(" "),
    filedVibro: report.filed?.vibro ? 1 : 0,
    analysisVersion: report.filed?.analysisVersion,
    currentLabel: report.current?.label,
    currentTiles: report.current?.tiles?.join(" "),
    suggestedTile: report.suggestedTile,
    suggestedFamily: report.suggestedFamily,
    suggestedLevel: report.suggestedLevel,
    suggestedTier: report.suggestedTier,
    suggestedRawDan: report.suggestedRawDan,
    rateable: report.rateable,
    rateableReasons: report.rateableReasons?.join(" "),
    username: report.username,
    userId: report.userId,
    played: report.played ? 1 : 0,
    reporterOverall: report.reporterOverall,
    note: report.note,
    title: report.chart?.title,
    version: report.chart?.version,
    createdAt: new Date(report.createdAt).toISOString(),
  }));
  return [CSV_COLUMNS.join(","), ...rows.map((row) => CSV_COLUMNS.map((column) => csvCell(row[column])).join(","))].join("\n") + "\n";
}

async function main() {
  const { values } = parseArgs({ options: {
    help: { type: "boolean", short: "h" }, remote: { type: "string" }, "remote-dir": { type: "string" },
  } });
  if (values.help) {
    console.log(`Usage: npm run label-reports:export -- [options]

Fetch production chart label reports through SSH (read-only).
Output: local-notes/label-reports/<timestamp>/reports.json and reports.csv.

  --remote TARGET   SSH target; defaults to LIVE_DB_SYNC_REMOTE in backend/.env
  --remote-dir DIR  Backend directory; defaults to LIVE_DB_SYNC_REMOTE_DIR or
                    ~/apps/mania-hub/backend`);
    return;
  }
  let env = {};
  try { env = parseEnv(await readFile(join(ROOT, "backend/.env"), "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const remote = values.remote || process.env.LIVE_DB_SYNC_REMOTE || env.LIVE_DB_SYNC_REMOTE;
  if (!remote) throw new Error("Set LIVE_DB_SYNC_REMOTE in backend/.env or pass --remote USER@HOST.");
  const remoteDir = values["remote-dir"] || process.env.LIVE_DB_SYNC_REMOTE_DIR || env.LIVE_DB_SYNC_REMOTE_DIR || "~/apps/mania-hub/backend";
  console.log("Fetching production chart label reports over SSH...");
  const payload = await fetchRemote(remote, remoteDir);
  const reports = Array.isArray(payload.reports) ? payload.reports : [];
  const output = join(ROOT, "local-notes/label-reports", new Date().toISOString().replaceAll(":", "-"));
  await mkdir(output, { recursive: true, mode: 0o700 });
  await writeFile(join(output, "reports.json"), JSON.stringify(payload, null, 2));
  await writeFile(join(output, "reports.csv"), toCsv(reports));
  console.log(`Exported ${reports.length} reports: ${output}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
