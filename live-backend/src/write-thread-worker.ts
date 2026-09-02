// Worker-thread entry for the serving process's writer (write-thread.ts).
// Holds one connection per target (main database, journal) and runs each
// request's statement groups through runWriteGroups, so SQLite's busy wait
// happens here and never on the event loop. Requests are handled strictly in
// order on one promise chain: two interleaved BEGIN/COMMIT sequences on the
// same connection would corrupt each other's transaction.
import { parentPort, workerData } from "node:worker_threads";
import { createDb, RECONNECT, type Db, type ReconnectHook } from "./db.js";
import { runWriteGroups, serializeError } from "./write-coalescer.js";
import type { WriteTarget, WriteThreadInit, WriteThreadRequest, WriteThreadResponse } from "./write-thread.js";

const port = parentPort;
if (!port) throw new Error("write-thread-worker must run as a worker thread");

const init = workerData as WriteThreadInit;
const connections = new Map<WriteTarget, Promise<Db>>();
let tail: Promise<unknown> = Promise.resolve();
let closing = false;

function connection(target: WriteTarget): Promise<Db> {
  let pending = connections.get(target);
  if (!pending) {
    const config = init.targets[target];
    if (!config) return Promise.reject(new Error(`write thread has no ${target} target`));
    pending = createDb(config);
    connections.set(target, pending);
  }
  return pending;
}

async function reopen(target: WriteTarget): Promise<boolean> {
  const db = await connection(target);
  const hook = (db as unknown as Record<symbol, unknown>)[RECONNECT] as ReconnectHook | undefined;
  if (!hook) return false;
  return hook("batch");
}

async function handle(request: WriteThreadRequest): Promise<WriteThreadResponse> {
  if (request.kind === "close") {
    closing = true;
    for (const pending of connections.values()) {
      try {
        (await pending).close();
      } catch {
        // Nothing left to protect.
      }
    }
    connections.clear();
    return { id: request.id, ok: true };
  }
  if (request.kind === "reopen") {
    return { id: request.id, ok: true, reopened: await reopen(request.target) };
  }
  const db = await connection(request.target);
  const result = await runWriteGroups(db, request.groups);
  if (result.poisoned) await reopen(request.target).catch(() => false);
  return { id: request.id, ok: true, outcomes: result.outcomes };
}

port.on("message", (request: WriteThreadRequest) => {
  tail = tail.then(async () => {
    let response: WriteThreadResponse;
    try {
      response = await handle(request);
    } catch (error) {
      response = { id: request.id, ok: false, error: serializeError(error) };
    }
    port.postMessage(response);
    if (closing) port.close();
  });
});
