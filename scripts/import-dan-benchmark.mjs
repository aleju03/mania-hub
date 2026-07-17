#!/usr/bin/env node
// One-time import of the Turso dan-benchmark export into the live backend.
// Usage:
//   node --env-file-if-exists=.env scripts/import-dan-benchmark.mjs planning/exports/dan-benchmark-export-2026-07-17.json
//   node scripts/import-dan-benchmark.mjs <export.json> --url https://api.mania-tracker.com --token <LIVE_ADMIN_TOKEN>
// Verifies row counts against the export afterwards. Delete this script once the
// prod import has run and been verified (tracked in the Turso-exit runbook).

import { readFile } from "node:fs/promises";

const args = process.argv.slice(2);
const filePath = args.find((arg) => !arg.startsWith("--"));
const flag = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};

const baseUrl = (flag("url") ?? process.env.LIVE_BACKEND_URL ?? "").replace(/\/$/, "");
const token = flag("token") ?? process.env.LIVE_ADMIN_TOKEN;

if (!filePath || !baseUrl || !token) {
  console.error("Usage: import-dan-benchmark.mjs <export.json> [--url <backend>] [--token <admin token>]");
  console.error("Defaults come from LIVE_BACKEND_URL / LIVE_ADMIN_TOKEN.");
  process.exit(1);
}

const exported = JSON.parse(await readFile(filePath, "utf8"));
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

const response = await fetch(`${baseUrl}/api/admin/dan-benchmark/import`, {
  method: "POST",
  headers,
  body: JSON.stringify({ labels: exported.labels, hidden: exported.hidden }),
});
if (!response.ok) {
  console.error(`Import failed (${response.status}): ${await response.text()}`);
  process.exit(1);
}
const result = await response.json();
console.log(`imported: labels=${result.labels} hidden=${result.hidden} skipped=${result.skipped}`);
console.log(`export had: labels=${exported.labels.length} hidden=${exported.hidden.length}`);

let importedLabels = 0;
let importedHidden = 0;
for (const family of ["normal", "ln", "ranked"]) {
  const labels = await (await fetch(`${baseUrl}/api/admin/dan-benchmark/labels?family=${family}`, { headers })).json();
  const hidden = await (await fetch(`${baseUrl}/api/admin/dan-benchmark/hidden?family=${family}`, { headers })).json();
  console.log(`  ${family}: labels=${labels.labels.length} hidden=${hidden.hidden.length}`);
  importedLabels += labels.labels.length;
  importedHidden += hidden.hidden.length;
}

if (importedLabels === exported.labels.length && importedHidden === exported.hidden.length) {
  console.log("VERIFIED: backend totals match the export.");
} else {
  console.error(`MISMATCH: backend has labels=${importedLabels} hidden=${importedHidden}.`);
  process.exit(1);
}
