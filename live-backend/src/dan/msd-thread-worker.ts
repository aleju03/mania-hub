import { parentPort } from "node:worker_threads";
import { calculateMsd } from "./msd-calc.js";
import type { MsdThreadRequest, MsdThreadResponse } from "./msd-thread.js";

const port = parentPort;
if (!port) throw new Error("msd-thread-worker must run as a worker thread");

// MinaCalc has mutable WASM state. Keep the entire async harness serialized,
// including its lazy initialization, even if more callers are added later.
let chain: Promise<void> = Promise.resolve();
port.on("message", (request: MsdThreadRequest) => {
  chain = chain.then(async () => {
    let response: MsdThreadResponse;
    try {
      response = { ok: true, id: request.id, result: await calculateMsd(request.osuText, request.options) };
    } catch (error) {
      response = { ok: false, id: request.id, error: error instanceof Error ? error.message : String(error) };
    }
    port.postMessage(response);
  });
});
