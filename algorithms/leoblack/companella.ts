import { classifyChartOnThread, classifyChartRcOnThread } from "../msd/inline";
import type { ChartClassificationData } from "../classification/chart-classification-data";
import { parseManiaBeatmap, type ManiaBeatmap } from "../chart/beatmap";
import { lnRatingIdentityUndecided } from "../classification/ln-identity";
import { isMarathonCorrectionCandidate, type ChartRcClassification, type ClassifyChartInput } from "../classification/chart-classifier";
import { getInputRate } from "../dan-estimator/labels";
import { prepareVibroChart } from "../vibro/sections";
import { computeMsd, msdChartErrorFallback } from "../msd/msd";
import type { CompanellaEstimate } from "leoblack/estimator/companellaEstimator";

export type { CompanellaEstimate };

export interface CompanellaFeatureInput {
  osuText: string;
  map?: ManiaBeatmap;
  rate: number;
  keyCount: number;
  sunnyStar: number;
}

export function isCompanellaSupported(keyCount: number): boolean {
  return keyCount === 4;
}

export async function computeCompanellaEstimate(
  input: CompanellaFeatureInput,
): Promise<CompanellaEstimate | null> {
  const { osuText, map, rate, keyCount, sunnyStar } = input;
  if (!isCompanellaSupported(keyCount) || !Number.isFinite(sunnyStar)) return null;

  try {
    const [{ calculateInterludeStar }, { classifyCompanellaDifficulty }] = await Promise.all([
      import("leoblack/interlude/index"),
      import("leoblack/estimator/companellaEstimator"),
    ]);

    const [msdValues, interludeStar] = await Promise.all([
      computeMsd(osuText, { rate, keyCount, etternaVersion: "0.74.0", includeLnSkill: false }, map)
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

export const COMPANELLA_RATE_FLOOR_STEPS = [0.05, 0.1] as const;
const COMPANELLA_RATE_FLOOR_MIN_RATE = 0.5;

export async function classifyChartWithCompanella(
  map: ManiaBeatmap,
  osuText: string,
  input: ClassifyChartInput = {},
  options: { msdValues?: Record<string, number> | null; skipCompanella?: boolean; rateFloor?: boolean } = {},
): Promise<ChartClassificationData> {
  input = { ...input, mixedCacheId: crypto.randomUUID() };
  const resolved = await resolveCompanella(map, osuText, input, classifyChartOnThread, {
    ...options, needsNativeMsd: (first) => lnRatingIdentityUndecided(first.keyCount, first),
  });
  if (!resolved.companella) return resolved.first;
  const rcFloor = options.rateFloor === false ? null : await companellaRcFloor(map, osuText, input);
  return classifyChartOnThread(map, osuText, { ...resolved.classifyInput, companella: resolved.companella, rcFloor });
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
      { ...input, rate: lowerRate, marathonMsdValues: undefined, companella: undefined, rcFloor: undefined }, classifyChartRcOnThread);
    if (!lower.companella) continue;
    const { rc } = await classifyChartRcOnThread(map, osuText, { ...lower.classifyInput, companella: lower.companella });
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
  classify: (map: ManiaBeatmap, osuText: string, input: ClassifyChartInput) => Promise<T>,
  options: { msdValues?: Record<string, number> | null; skipCompanella?: boolean; needsNativeMsd?: (first: T) => boolean } = {},
): Promise<{ first: T; classifyInput: ClassifyChartInput; companella: CompanellaEstimate | null }> {
  const rate = getInputRate(input);
  const prepared = input.adjustVibro ? prepareVibroChart(osuText, rate, map) : null;
  const effectiveText = prepared?.osuText ?? osuText;
  const effectiveMap = prepared?.analysis.status === "adjusted" ? parseManiaBeatmap(effectiveText) : map;
  const marathon = isMarathonCorrectionCandidate(effectiveMap);
  let msdValues = options.msdValues ?? input.marathonMsdValues;
  if (marathon && !msdValues) {
    msdValues = await computeMsd(effectiveText, { rate, keyCount: map.keyCount }, effectiveMap)
        .then((msd) => msd?.values ?? null).catch(msdChartErrorFallback);
  }
  let classifyInput = { ...input, marathonMsdValues: msdValues };
  let first = await classify(map, osuText, classifyInput);
  if (!msdValues && options.needsNativeMsd?.(first)) {
    msdValues = await computeMsd(effectiveText, { rate, keyCount: map.keyCount }, effectiveMap)
      .then((msd) => msd?.values ?? null).catch(msdChartErrorFallback);
    if (msdValues) {
      classifyInput = { ...input, marathonMsdValues: msdValues };
      first = await classify(map, osuText, classifyInput);
    }
  }
  const unrefined = { first, classifyInput, companella: null };
  if (options.skipCompanella || !first.companellaPending || first.sunnySr == null) return unrefined;
  if (marathon && !msdValues) return unrefined;

  const companella = await computeCompanellaEstimate({
    osuText: effectiveText,
    map: effectiveMap,
    rate,
    keyCount: map.keyCount,
    sunnyStar: first.sunnySr,
  });
  return { first, classifyInput, companella };
}
