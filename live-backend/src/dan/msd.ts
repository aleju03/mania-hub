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

// MinaCalc rates the rice skeleton: LN tails never reach it, so hold-heavy
// charts underrate. The tail-aware pass (lnTailTaps) is a strict upper bound
// on the release work - a release is easier than a tap - so consumers blend
// toward it by a keymode-calibrated weight. Weights were fit on player
// cohorts (2026-07-19, ~140 players, LN-share cohorts vs pp-anchored
// residuals): 4K flattens the hybrid cohort at 0.1 (osu pp overpays 4K LN,
// so zeroing the ln-main residual against pp would overcorrect); the 0.74
// multi-key calc underrates 7K LN far harder and wants 0.3. Charts without
// holds produce identical rows either way, so rice values are untouched.
export const LN_TAIL_BLEND_BY_KEYMODE: Record<number, number> = { 4: 0.1, 6: 0.3, 7: 0.3 };
export const LN_TAIL_MIN_RATIO = 0.02;

/** Blend base MSD values toward the tail-aware pass by the keymode weight. */
export function blendLnTailValues(
  base: Record<string, number>,
  tails: Record<string, number>,
  keyCount: number,
): Record<string, number> {
  const blend = LN_TAIL_BLEND_BY_KEYMODE[keyCount] ?? 0;
  const values: Record<string, number> = {};
  for (const [name, atBase] of Object.entries(base)) {
    const atTails = Number(tails[name] ?? atBase);
    values[name] = blend > 0 && atBase > 0 && atTails > atBase
      ? atBase + blend * (atTails - atBase)
      : atBase;
  }
  return values;
}

/**
 * Display-ready LN-adjusted MSD: the blended values, or null when blending
 * changes nothing (rice charts, unsupported keymodes) so callers can hide
 * a redundant readout.
 */
export function lnAdjustedMsd(
  base: Record<string, number> | null,
  tails: Record<string, number> | null,
  keyCount: number,
): Record<string, number> | null {
  if (!base || !tails) return null;
  const blended = blendLnTailValues(base, tails, keyCount);
  return Number(blended.Overall ?? 0) - Number(base.Overall ?? 0) >= 0.005 ? blended : null;
}

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
  options: { rate?: number; keyCount?: number; scoreGoal?: number; lnTailTaps?: boolean } = {},
): Promise<MsdResult | null> {
  const keyCount = options.keyCount;
  if (keyCount != null && !isMsdSupportedKeyCount(keyCount)) return null;

  const run = msdChain.then(async () => {
    const ett = await loadEtt();
    const result = await ett.analyzeEtternaFromText(osuText, {
      musicRate: options.rate ?? 1,
      scoreGoal: options.scoreGoal,
      keyOverride: keyCount ?? null,
      lnTailTaps: options.lnTailTaps === true,
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
