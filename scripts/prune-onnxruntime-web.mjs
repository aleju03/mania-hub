#!/usr/bin/env node
// Drop the onnxruntime-web runtime variants we never load.
//
// The npm package ships four wasm backends and every source map. Companella
// (src/lib/companella.ts and the backend copy) pins executionProviders:["wasm"]
// with numThreads=1, in both Node and the browser, so only the plain
// ort-wasm-simd-threaded.wasm is ever fetched. The rest is ~87MB of dead weight
// on the VPS disk and in the Vercel build. This is the same trim upstream did by
// hand in 36edb44, done at install time so no binary enters git.
//
// IF YOU EVER ENABLE WebGPU/JSEP, JSPI, OR ASYNCIFY, remove the matching entry
// from UNUSED_WASM or inference will fail at runtime with a 404/ENOENT.
//
// Only binaries are removed, never the .mjs loaders: those are small and the
// bundles may reference them statically. Runs on postinstall for both packages;
// idempotent, and always exits 0 so a package layout change can never break an
// install.

import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

const UNUSED_WASM = [
  "ort-wasm-simd-threaded.asyncify.wasm",
  "ort-wasm-simd-threaded.jsep.wasm",
  "ort-wasm-simd-threaded.jspi.wasm",
];

const KEEP_WASM = "ort-wasm-simd-threaded.wasm";

async function sizeOf(path) {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

async function main() {
  const dist = join(process.cwd(), "node_modules", "onnxruntime-web", "dist");

  let entries;
  try {
    entries = await readdir(dist);
  } catch {
    // onnxruntime-web is not installed here (or npm has not linked it yet).
    return;
  }

  // Refuse to prune if the file we depend on is missing: that means the package
  // layout changed and this script's assumptions no longer hold.
  if (!entries.includes(KEEP_WASM)) {
    process.stdout.write(`prune-onnxruntime-web: ${KEEP_WASM} not found, skipping\n`);
    return;
  }

  const targets = [
    ...UNUSED_WASM.filter((name) => entries.includes(name)),
    ...entries.filter((name) => name.endsWith(".map")),
  ];

  let reclaimed = 0;
  for (const name of targets) {
    const path = join(dist, name);
    reclaimed += await sizeOf(path);
    await rm(path, { force: true });
  }

  if (reclaimed > 0) {
    process.stdout.write(
      `prune-onnxruntime-web: removed ${targets.length} files, ${(reclaimed / 1048576).toFixed(0)}MB reclaimed\n`,
    );
  }
}

try {
  await main();
} catch (error) {
  // Never fail an install over this.
  process.stdout.write(`prune-onnxruntime-web: skipped (${error instanceof Error ? error.message : String(error)})\n`);
}
