// Ported from src/lib/companella.ts (frontend). Keep the two copies in sync;
// the backend routes MSD through msd.ts so MinaCalc runs stay serialized
// against the job lanes rather than stacking CPU bursts on the event loop.
import type { ManiaBeatmap } from "./beatmap-parser.js";
import { classifyChart, type ChartClassification, type ClassifyChartInput } from "./chart-classifier.js";
import { getInputRate } from "./dan-estimator/labels.js";
import { computeMsd, msdChartErrorFallback } from "./msd.js";
import type { CompanellaEstimate } from "../../vendor/leoblack/estimator/companellaEstimator.js";

// Companella is LeoBlack's ONNX dan model: a 10-feature MLP over the eight
// MinaCalc skillsets plus Interlude SR and Sunny SR. Mixed reaches for it on
// the RC half of 4K LN-hybrid charts under 9 stars, where Sunny alone is weak
// (see mixedEstimator.js). Inference is async, so this lives beside the sync
// classifyChart rather than inside it and callers opt in.

export type { CompanellaEstimate };

export interface CompanellaFeatureInput {
  osuText: string;
  rate: number;
  keyCount: number;
  sunnyStar: number;
  /**
   * Raw (not LN-tail-blended) MinaCalc values, when the caller already has
   * them. Saves a second MinaCalc pass; chart-analysis stores MSD anyway.
   */
  msdValues?: Record<string, number> | null;
}

/** Companella only ever runs on the 4K path Mixed gates it behind. */
export function isCompanellaSupported(keyCount: number): boolean {
  return keyCount === 4;
}

/**
 * Compute the two inputs Mixed does not already have (MinaCalc MSD and
 * Interlude SR) and run the model. Returns null when the chart is out of scope
 * or any stage fails, which leaves callers on the Sunny fallback that shipped
 * before Companella was wired.
 */
export async function computeCompanellaEstimate(
  input: CompanellaFeatureInput,
): Promise<CompanellaEstimate | null> {
  const { osuText, rate, keyCount, sunnyStar } = input;
  if (!isCompanellaSupported(keyCount) || !Number.isFinite(sunnyStar)) return null;

  try {
    // Both stay dynamic so the onnxruntime wasm and the Interlude tree never
    // enter the boot module graph (guarded by tests/boot-imports.test.ts).
    const [{ calculateInterludeStar }, { classifyCompanellaDifficulty }] = await Promise.all([
      import("../../vendor/leoblack/interlude/index.js"),
      import("../../vendor/leoblack/estimator/companellaEstimator.js"),
    ]);

    // computeMsd defaults to lnTailTaps:false, i.e. the raw MinaCalc values
    // rather than our LN-tail blend. That is deliberate: the model was trained
    // against stock MSD, so the blend would shift every hold-heavy chart off
    // the distribution it learned.
    const [msdValues, interludeStar] = await Promise.all([
      input.msdValues ?? computeMsd(osuText, { rate, keyCount }).then((msd) => msd?.values ?? null),
      calculateInterludeStar(osuText, rate),
    ]);
    if (!msdValues) return null;

    return await classifyCompanellaDifficulty({
      msdValues,
      interludeStar,
      sunnyStar,
    });
  } catch (error) {
    return msdChartErrorFallback(error);
  }
}

/**
 * classifyChart, plus the Companella pass when the chart asks for one. The
 * second classify only runs on that narrow slice; every other chart pays a
 * single sync classify exactly as before.
 */
export async function classifyChartWithCompanella(
  map: ManiaBeatmap,
  osuText: string,
  input: ClassifyChartInput = {},
  options: { msdValues?: Record<string, number> | null } = {},
): Promise<ChartClassification> {
  const first = classifyChart(map, osuText, input);
  if (!first.companellaPending || first.sunnySr == null) return first;

  const companella = await computeCompanellaEstimate({
    osuText,
    rate: getInputRate(input),
    keyCount: map.keyCount,
    sunnyStar: first.sunnySr,
    msdValues: options.msdValues,
  });
  if (!companella) return first;

  return classifyChart(map, osuText, { ...input, companella });
}
