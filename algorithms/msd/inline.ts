// The backend runs these on worker threads; here they run inline.
import type { ManiaBeatmap } from "../chart/beatmap";
import { chartClassificationData } from "../classification/chart-classification-data";
import { classifyChart, classifyChartRc, type ClassifyChartInput } from "../classification/chart-classifier";
import { analyzeAnyLnSkillFromText } from "../prism/ln-skill";
import { analyzeLnSsr } from "../ln/ssr";
import { analyzePrismFromText } from "../prism";
import { checkRateVibro } from "../vibro/rate";
import { analyzeEtternaFromText } from "./minacalc";
import type { MsdOptions, MsdResult } from "./msd";

export class AnalysisThreadUnavailableError extends Error {}
export class MsdThreadUnavailableError extends Error {}

export const analyzeLnSkillOnThread = async (osuText: string, options: Parameters<typeof analyzeAnyLnSkillFromText>[1] = {}) =>
  analyzeAnyLnSkillFromText(osuText, options);
export const analyzePrismOnThread = async (osuText: string, options: Parameters<typeof analyzePrismFromText>[1] = {}) =>
  analyzePrismFromText(osuText, options);
export const analyzeLnSsrOnThread = async (osuText: string, options: Parameters<typeof analyzeLnSsr>[1]) =>
  analyzeLnSsr(osuText, options);
export const classifyChartOnThread = async (map: ManiaBeatmap, osuText: string, input: ClassifyChartInput = {}) =>
  chartClassificationData(classifyChart(map, osuText, input));
export const classifyChartRcOnThread = async (map: ManiaBeatmap, osuText: string, input: ClassifyChartInput = {}) =>
  classifyChartRc(map, osuText, input);
export const checkRateVibroOnThread = async (osuText: string, rate: number, hasPpTrust: boolean, baseVibro: boolean) =>
  checkRateVibro(osuText, rate, hasPpTrust, baseVibro);

export async function computeMsdOnThread(osuText: string, options: MsdOptions): Promise<MsdResult> {
  const result = await analyzeEtternaFromText(osuText, {
    etternaVersion: options.etternaVersion,
    musicRate: options.rate ?? 1,
    scoreGoal: options.scoreGoal,
    keyOverride: options.keyCount ?? null,
    lnTailTaps: options.lnTailTaps === true,
  });
  return { etternaVersion: result.etternaVersion ?? "unknown", values: result.values };
}
