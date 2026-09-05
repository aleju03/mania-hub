import { Worker, type WorkerOptions } from "node:worker_threads";

/** Load the same worker from compiled production JS or source-mode tsx. */
export function createModuleWorker(entry: URL, options: WorkerOptions = {}): Worker {
  if (!import.meta.url.endsWith(".ts")) return new Worker(entry, options);
  const source = new URL(entry);
  source.pathname = source.pathname.replace(/\.js$/, ".ts");
  // Worker entrypoints do not inherit tsx's .js -> .ts resolution. Register
  // its scoped loader explicitly, only in development/tests.
  return new Worker(
    `import("tsx/esm/api").then(({ tsImport }) => tsImport(${JSON.stringify(source.href)}, ${JSON.stringify(import.meta.url)}));`,
    { ...options, eval: true },
  );
}
