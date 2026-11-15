import type { CustomThemeSourceResult } from "#custom-themes/source";

/* Runs the same checker the backend runs on save (backend
   custom-themes/source.ts) in a worker, so the editor shows its errors as the
   author types. A check that runs past CHECK_TIMEOUT_MS is a macro that never
   ends: the worker is thrown away and the next check starts a fresh one. */

const CHECK_TIMEOUT_MS = 4000;

let worker: Worker | null = null;
let nextId = 1;

function checker(): Worker {
  worker ??= new Worker(new URL("./custom-theme-check.worker.ts", import.meta.url), { type: "module" });
  return worker;
}

export interface CustomThemeCheck {
  result: CustomThemeSourceResult;
  /** The author's code numbered from its own first line, for the driver's errors. */
  lineProgram: string | null;
}

export function checkCustomThemeSource(source: string): Promise<CustomThemeCheck> {
  const id = nextId++;
  const running = checker();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      running.removeEventListener("message", onMessage);
      running.terminate();
      if (worker === running) worker = null;
      resolve({ result: { ok: false, errors: [{ code: "preprocess_failed", line: null, snippet: null, message: "Checking the code took too long: a #define probably expands without end." }] }, lineProgram: null });
    }, CHECK_TIMEOUT_MS);
    const onMessage = (event: MessageEvent<{ id: number } & CustomThemeCheck>) => {
      if (event.data.id !== id) return;
      clearTimeout(timer);
      running.removeEventListener("message", onMessage);
      resolve({ result: event.data.result, lineProgram: event.data.lineProgram });
    };
    running.addEventListener("message", onMessage);
    running.postMessage({ id, source });
  });
}
