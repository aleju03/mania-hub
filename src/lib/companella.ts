import { parseManiaBeatmap, type ManiaBeatmap } from "./beatmap-parser";
import { classifyChart, classifyChartRc, type ChartRcClassification, isMarathonCorrectionCandidate, type ChartClassification, type ClassifyChartInput } from "#dan/chart-classifier";
import { getInputRate } from "#dan/dan-estimator/labels";
import { prepareVibroChart } from "#dan/vibro-sections";
import type { CompanellaEstimate } from "#leoblack/estimator/companellaEstimator";

// Companella is LeoBlack's ONNX dan model: a 10-feature MLP over the eight
// MinaCalc skillsets plus Interlude SR and Sunny SR. Mixed reaches for it on
// low-band 4K RC charts and the RC half of LN hybrids under 9 stars
// (see mixedEstimator.js). Inference is async, so this lives beside the sync
// classifyChart rather than inside it and callers opt in.

export type { CompanellaEstimate };

export interface CompanellaFeatureInput {
  osuText: string;
  rate: number;
  keyCount: number;
  sunnyStar: number;
}

/** Companella only ever runs on the 4K path Mixed gates it behind. */
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
    // These three stay dynamic: the ett glue and the onnxruntime wasm are both
    // heavy, and a static import would drag them into every bundle that touches
    // the classifier (the raw ett glue leaking into build assets has regressed
    // twice already - see dd230f0 and b8a7554).
    const [{ analyzeEtternaFromText }, { calculateInterludeStar }, { classifyCompanellaDifficulty }] =
      await Promise.all([
        import("#leoblack/ett/index.js"),
        import("#leoblack/interlude/index.js"),
        import("#leoblack/estimator/companellaEstimator.js"),
      ]);

    // Companella has its own upstream MinaCalc version. Ordinary MSD and
    // marathon correction keep 0.72.3; their cached values cannot be reused.
    const [msdValues, interludeStar] = await Promise.all([
      analyzeEtternaFromText(osuText, { musicRate: rate, keyOverride: keyCount, etternaVersion: "0.74.0" })
        .then((msd) => msd.values),
      calculateInterludeStar(osuText, rate),
    ]);

    return await classifyCompanellaDifficulty({
      msdValues,
      interludeStar,
      sunnyStar,
    });
  } catch {
    return null;
  }
}

// Companella has no rate constraint, so a verdict it refines can dip as the
// rate rises: about 6% of 0.05x steps across 800 sampled 4K charts, by up to
// 0.7 of a dan. A faster play of a chart must not rate below a slower one, so
// a Companella-refined RC half is floored by the Companella-refined RC halves
// at the rates these steps below it. Each step costs one more classification,
// and only where Companella applies.
export const COMPANELLA_RATE_FLOOR_STEPS = [0.05, 0.1] as const;
const COMPANELLA_RATE_FLOOR_MIN_RATE = 0.5;

/**
 * Obtain marathon MSD before classifying, then resolve any Companella plan
 * using the resulting star value, floored by the rates just below
 * (COMPANELLA_RATE_FLOOR_STEPS). Other charts obtain MSD only if they need
 * Companella. skipCompanella keeps the benchmark's marathon correction active
 * while isolating the optional fusion; rateFloor: false leaves the verdict as
 * upstream computes it, for parity checks.
 */
export async function classifyChartWithCompanella(
  map: ManiaBeatmap,
  osuText: string,
  input: ClassifyChartInput = {},
  options: { msdValues?: Record<string, number> | null; skipCompanella?: boolean; rateFloor?: boolean } = {},
): Promise<ChartClassification> {
  input = { ...input, mixedCacheId: crypto.randomUUID() };
  const resolved = await resolveCompanella(map, osuText, input, classifyChart, options);
  if (!resolved.companella) return resolved.first;
  const rcFloor = options.rateFloor === false ? null : await companellaRcFloor(map, osuText, input);
  return classifyChart(map, osuText, { ...resolved.classifyInput, companella: resolved.companella, rcFloor });
}

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

async function resolveCompanella<T extends Pick<ChartRcClassification, "sunnySr" | "companellaPending">>(
  map: ManiaBeatmap,
  osuText: string,
  input: ClassifyChartInput,
  classify: (map: ManiaBeatmap, osuText: string, input: ClassifyChartInput) => T,
  options: { msdValues?: Record<string, number> | null; skipCompanella?: boolean } = {},
): Promise<{ first: T; classifyInput: ClassifyChartInput; companella: CompanellaEstimate | null }> {
  const rate = getInputRate(input);
  const prepared = input.adjustVibro ? prepareVibroChart(osuText, rate, map) : null;
  const effectiveText = prepared?.osuText ?? osuText;
  const effectiveMap = prepared?.analysis.status === "adjusted" ? parseManiaBeatmap(effectiveText) : map;
  const marathon = isMarathonCorrectionCandidate(effectiveMap);
  let msdValues = options.msdValues ?? input.marathonMsdValues;
  if (marathon && !msdValues) {
    msdValues = await import("#leoblack/ett/index.js")
        .then(({ analyzeEtternaFromText }) => analyzeEtternaFromText(effectiveText, { musicRate: rate, keyOverride: map.keyCount }))
        .then((msd) => msd.values).catch(() => null);
  }
  const classifyInput = { ...input, marathonMsdValues: msdValues };
  const first = classify(map, osuText, classifyInput);
  const unrefined = { first, classifyInput, companella: null };
  if (options.skipCompanella || !first.companellaPending || first.sunnySr == null) return unrefined;
  // A failed marathon MSD pass cannot supply Companella either. Do not retry
  // the same calculator a second time during this request.
  if (marathon && !msdValues) return unrefined;

  const companella = await computeCompanellaEstimate({
    osuText: effectiveText,
    rate,
    keyCount: map.keyCount,
    sunnyStar: first.sunnySr,
  });
  return { first, classifyInput, companella };
}
