// Node-side entry for the vendored Etterna MinaCalc WASM builds (src/lib/leoblack/ett/).
// The Emscripten glue is browser-targeted ES module output from an older Emscripten:
// in Node it reaches for require()/__dirname and fetches the .wasm over fetch(), so a
// few scoped shims are installed before the first calculation. Browser callers should
// import src/lib/leoblack/ett/index.js directly instead of this module.

import {
  analyzeEtternaFromText as analyzeEtternaFromTextRaw,
  type LeoBlackMsdOptions,
  type LeoBlackMsdResult,
} from "./leoblack/ett/index.js";

export type { LeoBlackMsdOptions, LeoBlackMsdResult };

let nodeShimsInstalled = false;

async function ensureNodeShims(): Promise<void> {
  if (nodeShimsInstalled || typeof window !== "undefined" || typeof process === "undefined") return;
  nodeShimsInstalled = true;

  const { createRequire } = await import("node:module");
  const { fileURLToPath } = await import("node:url");
  const { readFileSync } = await import("node:fs");

  const globalScope = globalThis as Record<string, unknown>;
  if (typeof globalScope.require === "undefined") {
    globalScope.require = createRequire(import.meta.url);
  }
  if (typeof globalScope.__dirname === "undefined") {
    globalScope.__dirname = fileURLToPath(new URL("./leoblack/ett/versions/", import.meta.url));
  }

  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("file://")) {
      return new Response(readFileSync(fileURLToPath(url)), {
        headers: { "Content-Type": "application/wasm" },
      });
    }
    return realFetch(input, init);
  }) as typeof fetch;
}

export async function analyzeLeoBlackMsd(osuText: string, options: LeoBlackMsdOptions = {}): Promise<LeoBlackMsdResult> {
  await ensureNodeShims();
  return analyzeEtternaFromTextRaw(osuText, options);
}
