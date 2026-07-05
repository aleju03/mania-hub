import { logWarn } from "../logger.js";

// Thin backend facade over the vendored MinaCalc wasm harness
// (vendor/leoblack/ett). calc.js handles the Node specifics itself (wasmBinary
// injection plus the CommonJS globals the emscripten glue expects), so this
// module only lazy-loads it, serializes calls, and trims the result.

export interface MsdResult {
  etternaVersion: string;
  values: Record<string, number>;
}

const MSD_SUPPORTED_KEYS = new Set([4, 6, 7]);

type EttModule = typeof import("../../vendor/leoblack/ett/index.js");

let ettModulePromise: Promise<EttModule> | null = null;
const loggedFallbackReasons = new Set<string>();

// One MinaCalc run at a time: each call is a synchronous CPU burst inside the
// wasm instance, and serializing keeps concurrent job lanes from stacking
// bursts on the event loop.
let msdChain: Promise<unknown> = Promise.resolve();

function loadEtt(): Promise<EttModule> {
  if (!ettModulePromise) {
    ettModulePromise = import("../../vendor/leoblack/ett/index.js");
  }
  return ettModulePromise;
}

export function isMsdSupportedKeyCount(keyCount: number): boolean {
  return MSD_SUPPORTED_KEYS.has(keyCount);
}

/**
 * Compute the Etterna MSD skillset values for a chart at the given rate.
 * `scoreGoal` is the target wife percent (default 0.93, the MSD baseline);
 * passing a score's accuracy turns the result into that score's SSR. The calc
 * clamps goals above 0.965 itself, mirroring Etterna's SSR cap.
 * Returns null for keymodes MinaCalc does not support (anything but 4/6/7K).
 */
export async function computeMsd(
  osuText: string,
  options: { rate?: number; keyCount?: number; scoreGoal?: number } = {},
): Promise<MsdResult | null> {
  const keyCount = options.keyCount;
  if (keyCount != null && !isMsdSupportedKeyCount(keyCount)) return null;

  const run = msdChain.then(async () => {
    const ett = await loadEtt();
    const result = await ett.analyzeEtternaFromText(osuText, {
      musicRate: options.rate ?? 1,
      scoreGoal: options.scoreGoal,
      keyOverride: keyCount ?? null,
    });
    if (result.etternaVersionFallbackReason && !loggedFallbackReasons.has(result.etternaVersionFallbackReason)) {
      // The 6K/7K preference for 0.74.0 is expected and fires on every non-4K
      // chart; log each distinct reason once instead of spamming the job logs.
      loggedFallbackReasons.add(result.etternaVersionFallbackReason);
      logWarn("msd_version_fallback", { reason: result.etternaVersionFallbackReason });
    }
    return {
      etternaVersion: result.etternaVersion ?? "unknown",
      values: result.values,
    };
  });
  msdChain = run.catch(() => {});
  return run;
}
