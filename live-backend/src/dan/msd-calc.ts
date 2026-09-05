import { logWarn } from "../logger.js";
import type { MsdOptions, MsdResult } from "./msd.js";

// Owned by the calculator thread. No serving/job-coordinator path imports
// this implementation: parsing and the synchronous WASM calls both run here.
type EttModule = typeof import("../../vendor/leoblack/ett/index.js");
let ettModulePromise: Promise<EttModule> | null = null;
const loggedFallbackReasons = new Set<string>();

export async function calculateMsd(osuText: string, options: MsdOptions): Promise<MsdResult> {
  const ett = await (ettModulePromise ??= import("../../vendor/leoblack/ett/index.js"));
  const result = await ett.analyzeEtternaFromText(osuText, {
    musicRate: options.rate ?? 1,
    scoreGoal: options.scoreGoal,
    keyOverride: options.keyCount ?? null,
    lnTailTaps: options.lnTailTaps === true,
  });
  if (result.etternaVersionFallbackReason && !loggedFallbackReasons.has(result.etternaVersionFallbackReason)) {
    loggedFallbackReasons.add(result.etternaVersionFallbackReason);
    logWarn("msd_version_fallback", { reason: result.etternaVersionFallbackReason });
  }
  return { etternaVersion: result.etternaVersion ?? "unknown", values: result.values };
}
