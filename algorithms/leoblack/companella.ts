// Companella is LeoBlack's ONNX dan model: a 10-feature MLP over the eight
// MinaCalc skillsets plus Interlude SR and Sunny SR. Mixed asks for it on
// low-band 4K rice charts and on the rice half of 4K LN hybrids under 9 stars.
// Inference is async, so this runs beside the sync chart classifier: classify
// once, run Companella if Mixed asked for it, then classify again with the result.
import { parseManiaBeatmap, type ManiaBeatmap } from "../chart/beatmap";
import { lnRatingIdentityUndecided } from "../classification/ln-identity";
import {
  classifyChart,
  classifyChartRc,
  isMarathonCorrectionCandidate,
  type ChartClassification,
  type ChartRcClassification,
  type ClassifyChartInput,
} from "../classification/chart-classifier";
import { getInputRate } from "../dan-estimator/labels";
import { prepareVibroChart } from "../vibro/sections";
import { computeMsd, msdChartErrorFallback } from "../msd/msd";
import { calculateInterludeStar } from "leoblack/interlude/index";
import { classifyCompanellaDifficulty, type CompanellaEstimate } from "leoblack/estimator/companellaEstimator";

export type { CompanellaEstimate };

export interface CompanellaFeatureInput {
  osuText: string;
  rate: number;
  keyCount: number;
  sunnyStar: number;
}

// Companella has no rate constraint, so a verdict it refines can dip as the
// rate rises: about 6% of 0.05x steps across 800 sampled 4K charts, by up to
// 0.7 of a dan. A faster play of a chart must not rate below a slower one, so
// a Companella-refined rice half is floored by the Companella-refined rice
// halves at these rate steps below it (and never below 0.5x). Each step costs
// one more classification, and only where Companella applies.
export const COMPANELLA_RATE_FLOOR_STEPS = [0.05, 0.1] as const;
const COMPANELLA_RATE_FLOOR_MIN_RATE = 0.5;

/** Companella only runs on the 4K path Mixed gates it behind. */
export function isCompanellaSupported(keyCount: number): boolean {
  return keyCount === 4;
}

/**
 * Compute the two inputs Mixed does not already have (MinaCalc MSD and
 * Interlude SR) and run the model. Returns null when the chart is out of scope
 * or any stage fails, which leaves callers on their unrefined Azusa or Sunny estimate.
 */
export async function computeCompanellaEstimate(
  input: CompanellaFeatureInput,
): Promise<CompanellaEstimate | null> {
  const { osuText, rate, keyCount, sunnyStar } = input;
  if (!isCompanellaSupported(keyCount) || !Number.isFinite(sunnyStar)) return null;

  try {
    // The model was trained on raw MinaCalc 0.74.0 skillsets, so it gets
    // those, not the 0.72.3 MSD the rest of 4K uses and not the LN-tail blend.
    const [msdValues, interludeStar] = await Promise.all([
      computeMsd(osuText, { rate, keyCount, etternaVersion: "0.74.0", includeLnSkill: false })
        .then((msd) => msd?.values ?? null),
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
 * Classify a chart with Companella applied where Mixed asks for it.
 * Marathon charts get MSD before classifying (Mixed's marathon correction
 * reads it); other charts get it only if Companella or the LN identity
 * tiebreak needs it. A Companella-refined rice half is then floored by the
 * rates just below (COMPANELLA_RATE_FLOOR_STEPS). skipCompanella keeps the
 * marathon correction but leaves out the model; rateFloor: false leaves the
 * verdict as LeoBlack computes it.
 */
export async function classifyChartWithCompanella(
  map: ManiaBeatmap,
  osuText: string,
  input: ClassifyChartInput = {},
  options: { msdValues?: Record<string, number> | null; skipCompanella?: boolean; rateFloor?: boolean } = {},
): Promise<ChartClassification> {
  const resolved = await resolveCompanella(map, osuText, input, classifyChart, {
    ...options, needsNativeMsd: (first) => lnRatingIdentityUndecided(first.keyCount, first),
  });
  if (!resolved.companella) return resolved.first;
  const rcFloor = options.rateFloor === false ? null : await companellaRcFloor(map, osuText, input);
  return classifyChart(map, osuText, { ...resolved.classifyInput, companella: resolved.companella, rcFloor });
}

// The highest Companella-refined rice verdict at the floor-step rates below
// the requested one, or null if Companella applies at none of them.
async function companellaRcFloor(
  map: ManiaBeatmap,
  osuText: string,
  input: ClassifyChartInput,
): Promise<ClassifyChartInput["rcFloor"]> {
  const rate = getInputRate(input);
  let floor: ClassifyChartInput["rcFloor"] = null;
  for (const step of COMPANELLA_RATE_FLOOR_STEPS) {
    const lowerRate = Math.round((rate - step) * 100) / 100;
    if (lowerRate < COMPANELLA_RATE_FLOOR_MIN_RATE) break;
    const lower = await resolveCompanella(map, osuText,
      { ...input, rate: lowerRate, marathonMsdValues: undefined, companella: undefined, rcFloor: undefined }, classifyChartRc);
    if (!lower.companella) continue;
    const { rc } = classifyChartRc(map, osuText, { ...lower.classifyInput, companella: lower.companella });
    if (rc?.source === "leoblack-companella" && rc.rawDan > (floor?.numeric ?? -Infinity)) {
      floor = { text: rc.raw, numeric: rc.rawDan };
    }
  }
  return floor;
}

// One unrefined classification plus, when Mixed asked for it, the Companella
// estimate that refines it. `classify` is the full classifier or the rice-only one.
async function resolveCompanella<T extends Pick<ChartRcClassification, "sunnySr" | "companellaPending">>(
  map: ManiaBeatmap,
  osuText: string,
  input: ClassifyChartInput,
  classify: (map: ManiaBeatmap, osuText: string, input: ClassifyChartInput) => T,
  options: { msdValues?: Record<string, number> | null; skipCompanella?: boolean; needsNativeMsd?: (first: T) => boolean } = {},
): Promise<{ first: T; classifyInput: ClassifyChartInput; companella: CompanellaEstimate | null }> {
  const rate = getInputRate(input);
  const prepared = input.adjustVibro ? prepareVibroChart(osuText, rate, map) : null;
  const effectiveText = prepared?.osuText ?? osuText;
  const effectiveMap = prepared?.analysis.status === "adjusted" ? parseManiaBeatmap(effectiveText) : map;
  const marathon = isMarathonCorrectionCandidate(effectiveMap);
  let msdValues = options.msdValues ?? input.marathonMsdValues;
  if (marathon && !msdValues) {
    msdValues = await computeMsd(effectiveText, { rate, keyCount: map.keyCount })
      .then((msd) => msd?.values ?? null).catch(msdChartErrorFallback);
  }
  let classifyInput = { ...input, marathonMsdValues: msdValues };
  let first = classify(map, osuText, classifyInput);
  // A full classification may need native Overall for its LN identity.
  // Rice-only floor probes skip it: identity cannot change the rice verdict.
  // Marathon MSD above is still required for Mixed routing at every rate.
  if (!msdValues && options.needsNativeMsd?.(first)) {
    msdValues = await computeMsd(effectiveText, { rate, keyCount: map.keyCount })
      .then((msd) => msd?.values ?? null).catch(msdChartErrorFallback);
    if (msdValues) {
      classifyInput = { ...input, marathonMsdValues: msdValues };
      first = classify(map, osuText, classifyInput);
    }
  }
  const unrefined = { first, classifyInput, companella: null };
  if (options.skipCompanella || !first.companellaPending || first.sunnySr == null) return unrefined;
  // A marathon chart whose MSD failed cannot supply Companella either; the
  // same calculator is not retried within one request.
  if (marathon && !msdValues) return unrefined;

  const companella = await computeCompanellaEstimate({
    osuText: effectiveText,
    rate,
    keyCount: map.keyCount,
    sunnyStar: first.sunnySr,
  });
  return { first, classifyInput, companella };
}
