// Boot import-graph probe (Phase 4 of findings/README.md).
//
// Spawns a fresh Node process per entry module, imports it, and reports the
// process RSS plus any known-heavy dependency that ended up in the module
// graph. The worker entry is src/workers.ts and the serving entry is
// src/http/snapshots.ts; neither may load Playwright, sharp, jszip,
// sanitize-html, or the AWS SDK at boot — those are all lazy-imported at their
// single point of use.
//
// Usage: npm run probe:boot-imports   (exits non-zero if a heavy dep loaded)
//
// Caveats: RSS here includes tsx's compile overhead, so absolute numbers are
// higher than a compiled dist boot — compare deltas between runs, not the raw
// value against production. Detection uses the CJS require cache, which works
// because every listed dependency ships as CommonJS today; an ESM-only
// replacement would need a different probe.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HEAVY_DEPS = [
  "playwright",
  "node_modules/sharp",
  "node_modules/jszip",
  "sanitize-html",
  "@aws-sdk",
  "@smithy",
];

const ENTRIES = ["src/workers.ts", "src/http/snapshots.ts"];

const backendRoot = fileURLToPath(new URL("../..", import.meta.url));

let failed = false;
for (const entry of ENTRIES) {
  const childCode = `
    await import(${JSON.stringify(`./${entry}`)});
    const { createRequire } = await import("node:module");
    const keys = Object.keys(createRequire(import.meta.url).cache ?? {});
    const heavy = ${JSON.stringify(HEAVY_DEPS)}.filter((dep) => keys.some((path) => path.includes(dep)));
    console.log(JSON.stringify({
      entry: ${JSON.stringify(entry)},
      rssMb: Math.round(process.memoryUsage().rss / 1048576 * 10) / 10,
      heavyDepsLoaded: heavy,
    }));
  `;
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", childCode],
    { cwd: backendRoot, encoding: "utf8", timeout: 120_000 },
  );
  if (result.status !== 0) {
    console.error(`[boot-import-probe] ${entry} failed to import:\n${result.stderr}`);
    failed = true;
    continue;
  }
  const line = result.stdout.trim().split("\n").pop() ?? "{}";
  console.log(line);
  const parsed = JSON.parse(line) as { heavyDepsLoaded: string[] };
  if (parsed.heavyDepsLoaded.length > 0) failed = true;
}

if (failed) {
  console.error("[boot-import-probe] heavy dependencies leaked into a boot module graph");
  process.exitCode = 1;
}
