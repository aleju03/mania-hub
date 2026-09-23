#!/usr/bin/env node
// Backport Vite's SSR/HMR cycle detection fixes to the pinned Vite 7 runner.
// https://github.com/vitejs/vite/pull/22369
// https://github.com/vitejs/vite/pull/23009
// Remove this backport when migrating to a Vite release containing both fixes.
// Adapted from Vite (MIT); see scripts/dev/VITE-LICENSE.txt.
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const marker = "// mania-hub: Vite #22369 + #23009";

const replacement = `\t${marker}
\tisCircularRequest(mod, callstack, visited = new Set()) {
\t\tif (visited.has(mod.id)) return false;
\t\tvisited.add(mod.id);
\t\tfor (const importedModuleId of mod.imports) {
\t\t\tconst importedModule = this.evaluatedModules.getModuleById(importedModuleId);
\t\t\tif (!importedModule?.promise || importedModule.evaluated) continue;
\t\t\tif (callstack.includes(importedModuleId) || this.isCircularRequest(importedModule, callstack, visited)) return true;
\t\t}
\t\treturn false;
\t}
\tasync cachedRequest(url, mod, callstack = [], metadata) {
\t\tconst meta = mod.meta, moduleId = meta.id, importee = callstack[callstack.length - 1];
\t\tif (importee) mod.importers.add(importee);
\t\tif (mod.evaluated && mod.promise) return this.processImport(await mod.promise, meta, metadata);
\t\tif (mod.promise) {
\t\t\tif (mod.exports && (callstack.includes(moduleId) || this.isCircularRequest(mod, callstack))) {
\t\t\t\treturn this.processImport(mod.exports, meta, metadata);
\t\t\t}
\t\t\treturn this.processImport(await mod.promise, meta, metadata);
\t\t}
\t\tlet debugTimer;
\t\tif (this.debug) debugTimer = setTimeout(() => {
\t\t\tthis.debug("[module runner] module " + moduleId + " takes over 2s to load.\\nstack:\\n" + [...callstack, moduleId].reverse().join("\\n"));
\t\t}, 2000);
\t\ttry {
\t\t\tconst promise = this.directRequest(url, mod, callstack);
\t\t\tmod.promise = promise;
\t\t\tmod.evaluated = false;
\t\t\treturn this.processImport(await promise, meta, metadata);
\t\t} finally {
\t\t\tmod.evaluated = true;
\t\t\tif (debugTimer) clearTimeout(debugTimer);
\t\t}
\t}
`;

async function main() {
  let runnerPath;
  try {
    runnerPath = require.resolve("vite/module-runner");
  } catch (error) {
    if (error.code === "MODULE_NOT_FOUND") return; // Production install without dev dependencies.
    throw error;
  }
  const { version } = JSON.parse(await readFile(require.resolve("vite/package.json"), "utf8"));
  if (version !== "7.3.6") {
    throw new Error(`Review the SSR/HMR backport before changing Vite ${version}; expected 7.3.6.`);
  }
  const source = await readFile(runnerPath, "utf8");
  if (source.includes(replacement)) return;
  const originalHash = "e9e66cba21fc780ae9a5a64da48503afa49bf9bc25c69007333c7835b763b89c";
  if (createHash("sha256").update(source).digest("hex") !== originalHash) {
    throw new Error("Vite's module runner differs from the verified 7.3.6 file; refusing to patch it.");
  }
  const start = source.indexOf("\tisCircularModule(mod) {");
  const end = source.indexOf("\tasync cachedModule(url, importer) {", start);
  if (start < 0 || end < 0) throw new Error("Vite SSR/HMR patch anchors are missing.");
  await writeFile(runnerPath, source.slice(0, start) + replacement + source.slice(end));
  process.stdout.write("Applied Vite SSR hot-reload fixes (#22369, #23009).\n");
}

await main();
