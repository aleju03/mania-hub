#!/usr/bin/env node
// Stop finished environment builds from staying in memory during `vite build`.
//
// The client, SSR and Nitro builds run one after another in a single Node
// process. Each of the dependencies below keeps something that references the
// Rollup build after it ends, so every finished environment's whole module
// graph stayed alive until the process exited. The Nitro build then ran with
// all three graphs in memory and outgrew Node's ~4 GB default heap in CI.
// Patched, the peak live heap goes from ~4.0 GB to ~2.0 GB with byte-identical
// output.
//
// - enhanced-resolve (via @tailwindcss/node) caches fs errors. An Error whose
//   .stack was never read keeps the call frames it was created in, which here
//   include Rollup's ModuleLoader. Reading .stack formats it and drops them.
//   exsolve had the same bug and fixed it the same way in 1.1.3.
// - @tanstack/start-plugin-core keeps one StartCompiler per environment, and
//   its loadModule/resolveId closures capture the plugin context.
// - @tailwindcss/vite keeps per-environment CSS roots in build mode, and each
//   root's compiler captures the plugin context through addWatchFile.
//
// Each patch is anchor-based and idempotent. If an anchor is gone (a dependency
// changed or fixed it upstream) this warns instead of failing the install;
// check whether the leak is still there before deleting the entry.

import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const marker = "/* mania-hub: release build graph */";

const PATCHES = [
  {
    name: "enhanced-resolve cached fs errors",
    file: () => join(dirname(require.resolve("enhanced-resolve/package.json")), "lib/CachedInputFileSystem.js"),
    anchor: "\t_storeResult(path, err, result) {\n",
    insert: `\t\tif (err) void err.stack; ${marker}\n`,
  },
  {
    name: "@tanstack/start-plugin-core server-fn compilers",
    file: () =>
      join(
        dirname(require.resolve("@tanstack/start-plugin-core/package.json")),
        "dist/esm/vite/start-compiler-plugin/plugin.js",
      ),
    anchor:
      'if (this.environment.mode === "build" || bundledDev && this.environment.name === VITE_ENVIRONMENT_NAMES.client) compilers.delete(this.environment.name);\n\t\t\t},\n',
    insert: `\t\t\tbuildEnd() { ${marker}\n\t\t\t\tif (this.environment.mode === "build") compilers.delete(this.environment.name);\n\t\t\t},\n`,
  },
  {
    name: "@tailwindcss/vite build roots",
    // Its exports map has no ./package.json; this resolves to dist/index.mjs.
    file: () => fileURLToPath(import.meta.resolve("@tailwindcss/vite")),
    anchor: '{name:"@tailwindcss/vite:generate:build",apply:"build",enforce:"pre",',
    // Minified: `t` is the per-environment root map only while this line matches.
    requires: 'let o=t.get(this.environment?.name??"default");let f=o.get(l);',
    insert: `buildEnd(){${marker}t.delete(this.environment?.name??"default")},`,
  },
];

async function apply(patch) {
  let path;
  try {
    path = patch.file();
  } catch (error) {
    if (error.code === "MODULE_NOT_FOUND" || error.code === "ERR_MODULE_NOT_FOUND") return; // Production install without dev dependencies.
    throw error;
  }
  const source = await readFile(path, "utf8");
  if (source.includes(marker)) return;
  const at = source.indexOf(patch.anchor);
  if (at < 0 || source.indexOf(patch.anchor, at + 1) >= 0 || (patch.requires && !source.includes(patch.requires))) {
    process.stderr.write(`patch-build-memory-leaks: anchor for ${patch.name} not found in ${path}; skipped.\n`);
    return;
  }
  const end = at + patch.anchor.length;
  await writeFile(path, source.slice(0, end) + patch.insert + source.slice(end));
  process.stdout.write(`Patched build memory leak: ${patch.name}.\n`);
}

for (const patch of PATCHES) await apply(patch);
